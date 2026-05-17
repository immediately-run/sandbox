import { configureSingle } from '@zenfs/core';
import { Port } from '@zenfs/core/backends/port.js';

import { Bundler } from './bundler/bundler';
import { ErrorRecord, listenToRuntimeErrors } from './error-listener';
import { BundlerError } from './errors/BundlerError';
import { CompilationError } from './errors/CompilationError';
import { errorMessage } from './errors/util';
import { handleEvaluate, hookConsole } from './integrations/console';
import { IFrameParentMessageBus } from './protocol/iframe';
import { ICompileRequest } from './protocol/message-types';
import { Debouncer } from './utils/Debouncer';
import { DisposableStore } from './utils/Disposable';
import { getDocumentHeight } from './utils/document';
import {loadCachedResponses} from './utils/fetch'
import * as logger from './utils/logger';
import cachedRequestInfo from './config/cached_requests.json'

const bundlerStartTime = Date.now();

class SandpackInstance {
  private messageBus: IFrameParentMessageBus;
  private disposableStore = new DisposableStore();
  private bundler!: Bundler;
  private compileDebouncer = new Debouncer(50);
  private lastHeight: number = 0;
  private resizePollingTimer: NodeJS.Timer | undefined;
  private readyPromise: Promise<void>;

  constructor() {
    this.messageBus = new IFrameParentMessageBus();

    this.readyPromise = this.bootstrap().catch((err) => {
      logger.error('Failed to bootstrap sandpack instance', err);
      throw err;
    });
  }

  private async bootstrap() {
    // Mount the parent's zenfs instance over the MessagePort transferred in
    // the `register-frame` handshake. Any `fs.promises.*` call in the iframe
    // will be forwarded to the parent via zenfs's Port RPC.
    const fsPort = await this.messageBus.getFsPort();
    // The zenfs `Port` backend accepts any WebMessagePort-shaped object; the
    // DOM `MessagePort` satisfies this structurally even though TS's union
    // also includes `WebSocket`.
    await configureSingle({ backend: Port, port: fsPort as any });

    this.bundler = new Bundler({ messageBus: this.messageBus });

    const disposeOnMessage = this.messageBus.onMessage((msg) => {
      this.handleParentMessage(msg);
    });
    this.disposableStore.add(disposeOnMessage);

    this.init().catch(logger.error);

    listenToRuntimeErrors(this.bundler, (runtimeError: ErrorRecord) => {
      const stackFrame = runtimeError.stackFrames[0] ?? {};

      this.messageBus.sendMessage('action', {
        action: 'show-error',

        title: 'Runtime Exception',
        line: stackFrame._originalLineNumber,
        column: stackFrame._originalColumnNumber,
        // @ts-ignore
        path: runtimeError.error.path,
        message: runtimeError.error.message,
        payload: { frames: runtimeError.stackFrames },
      });
    });

    // Console logic
    hookConsole((log) => {
      this.messageBus.sendMessage('console', { log });
    });
    this.messageBus.onMessage((data: any) => {
      if (typeof data === 'object' && data.type === 'evaluate') {
        const result = handleEvaluate(data.command);
        if (result) {
          this.messageBus.sendMessage('console', result);
        }
      }
    });
  }

  handleParentMessage(message: any) {
    switch (message.type) {
      case 'compile':
        this.compileDebouncer.debounce(() =>
          this.readyPromise
            .then(() => this.handleCompile(message))
            .catch(logger.error)
        );
        break;
      case 'refresh':
        window.location.reload();
        this.messageBus.sendMessage('refresh');
        break;
    }
  }

  sendResizeEvent = () => {
    const height = getDocumentHeight();

    if (this.lastHeight !== height) {
      this.messageBus.sendMessage('resize', { height });
    }

    this.lastHeight = height;
  };

  initResizeEvent() {
    const resizePolling = () => {
      if (this.resizePollingTimer) {
        clearInterval(this.resizePollingTimer as NodeJS.Timeout);
      }

      this.resizePollingTimer = setInterval(this.sendResizeEvent, 300);
    };

    resizePolling();

    /**
     * Ideally we should only use a `MutationObserver` to trigger a resize event,
     * however, we noted that it's not 100% reliable, so we went for polling strategy as well
     */
    let throttle: NodeJS.Timeout | undefined;
    const observer = new MutationObserver(() => {
      if (throttle === undefined) {
        this.sendResizeEvent();

        throttle = setTimeout(() => {
          throttle = undefined;
        }, 300);
      }
    });
    observer.observe(document, { attributes: true, childList: true, subtree: true });
  }

  async init() {
    this.messageBus.sendMessage('initialized');

    for (let url of cachedRequestInfo.locations) {
      loadCachedResponses(url)
    }

    this.bundler.onStatusChange((newStatus) => {
      this.messageBus.sendMessage('status', { status: newStatus });
    });
  }

  async handleCompile(compileRequest: ICompileRequest) {
    if (compileRequest.logLevel != null) {
      logger.setLogLevel(compileRequest.logLevel);
    }

    logger.debug(logger.logFactory('Init'));

    // -- FileSystem
    const initStartTimeFileSystem = Date.now();
    logger.debug(logger.logFactory('FileSystem'));

    this.messageBus.sendMessage('start', {
      firstLoad: this.bundler.isFirstLoad,
    });

    this.messageBus.sendMessage('status', { status: 'initializing' });

    if (this.bundler.isFirstLoad) {
      this.bundler.resetModules();
    }
    logger.debug(logger.logFactory('FileSystem', `finished in ${Date.now() - initStartTimeFileSystem}ms`));

    // --- Load preset
    logger.groupCollapsed(logger.logFactory('Preset and transformers'));
    const initStartTime = Date.now();
    await this.bundler.initPreset(compileRequest.template);
    logger.debug(logger.logFactory('Preset and transformers', `finished in ${Date.now() - initStartTime}ms`));
    logger.groupEnd();

    // --- Bundling / Compiling
    logger.groupCollapsed(logger.logFactory('Bundling'));
    const bundlingStartTime = Date.now();
    const evaluate = await this.bundler
      .compile()
      .then((val) => {
        this.messageBus.sendMessage('done', {
          compilatonError: false,
        });

        return val;
      })
      .catch((error: CompilationError) => {
        logger.error(error);

        this.messageBus.sendMessage('action', errorMessage(error));

        this.messageBus.sendMessage('done', {
          compilatonError: true,
        });
      })
      .finally(() => {
        logger.debug(logger.logFactory('Bundling', `finished in  ${Date.now() - bundlingStartTime}ms`));
        logger.groupEnd();
      });

    // --- Replace HTML
    this.bundler.replaceHTML();

    // --- Evaluation
    if (evaluate) {
      this.messageBus.sendMessage('status', { status: 'evaluating' });

      try {
        logger.groupCollapsed(logger.logFactory('Evaluation'));
        const evalStartTime = Date.now();

        evaluate();

        this.messageBus.sendMessage('success');

        logger.debug(logger.logFactory('Evaluation', `finished in ${Date.now() - evalStartTime}ms`));
        logger.groupEnd();
      } catch (error: unknown) {
        logger.error(error);

        this.messageBus.sendMessage(
          'action',
          errorMessage(error as BundlerError) // TODO: create a evaluation error
        );
      }

      this.initResizeEvent();
    }

    logger.debug(logger.logFactory('Finished', `in ${Date.now() - bundlerStartTime}ms`));
    this.messageBus.sendMessage('status', { status: 'done' });
  }

  dispose() {
    this.disposableStore.dispose();
  }
}

// @ts-ignore
window['sandpack'] = new SandpackInstance();
