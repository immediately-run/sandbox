import { fs, mount, umount, configure, resolveMountConfig, bindContext } from '@zenfs/core';
import { Port } from '@zenfs/core/backends/port.js';

import { Bundler } from './bundler/bundler';
import { ErrorRecord, listenToRuntimeErrors } from './error-listener';
import { BundlerError } from './errors/BundlerError';
import { CompilationError } from './errors/CompilationError';
import { errorMessage } from './errors/util';
import { handleEvaluate, hookConsole } from './integrations/console';
import { IFrameParentMessageBus } from './protocol/iframe';
import { AuthService } from './auth/AuthService';
import { REQUEST_AUTH_STATE_MESSAGE } from './auth/authState';
import { ThemeService } from './theme/ThemeService';
import { REQUEST_THEME_MESSAGE } from './theme/themeState';
import { EditorContextService } from './editor/EditorContextService';
import { REQUEST_EDITOR_CONTEXT_MESSAGE } from './editor/editorContextState';
import { CatalogService } from './catalog/CatalogService';
import { REQUEST_CATALOG_MESSAGE } from './catalog/catalogState';
import { FormFactorService } from './formFactor/FormFactorService';
import { REQUEST_FORM_FACTOR_MESSAGE } from './formFactor/formFactorState';
import { MountService } from './mounts/MountService';
import {
  MOUNT_ADD_MESSAGE,
  MOUNT_REMOVE_MESSAGE,
  REQUEST_MOUNTS_MESSAGE,
  SandboxMount,
} from './mounts/mountState';
import { APP_ROOT, underAppRoot } from './fsLayout';
import { Debouncer } from './utils/Debouncer';
import { DisposableStore } from './utils/Disposable';
import { getDocumentHeight } from './utils/document';
import { registerParentImmutableFetch, ParentImmutableFetchResult } from './utils/fetch';
import * as logger from './utils/logger';

const bundlerStartTime = Date.now();

/**
 * ZenFS routes paths to mounted filesystems through its mount table alone —
 * `mount(path, fs)` creates no directory entry in the parent filesystem. A
 * mount point is therefore invisible to `readdir` of its parent: app code
 * listing `/` would never see `/app` (or `/spaces/...`), only an empty
 * in-memory root. Materialize the mount point as a real (empty) directory in
 * the underlying filesystem so mounts show up in listings.
 *
 * MUST be called BEFORE `mount()` — once the mount exists, the path resolves
 * into the mounted filesystem and the mkdir would land there instead.
 */
async function materializeMountPoint(path: string): Promise<void> {
  try {
    await fs.promises.mkdir(path, { recursive: true });
  } catch (err) {
    logger.error(`Failed to materialize mount point ${path}`, err);
  }
}

class SandpackInstance {
  private messageBus: IFrameParentMessageBus;
  private authService: AuthService;
  private themeService: ThemeService;
  private editorContextService: EditorContextService;
  private catalogService: CatalogService;
  private formFactorService: FormFactorService;
  private mountService: MountService;
  private disposableStore = new DisposableStore();
  private bundler!: Bundler;
  private compileDebouncer = new Debouncer(50);
  private template!: string;
  private lastHeight: number = 0;
  private resizePollingTimer: NodeJS.Timer | undefined;
  private readyPromise: Promise<void>;

  constructor() {
    this.messageBus = new IFrameParentMessageBus();
    // Created before the bundler (and before bootstrap awaits the fs port) so an
    // `auth-state` message that arrives early is captured rather than dropped.
    this.authService = new AuthService(this.messageBus);
    // Likewise for the host theme, so a `theme` message that arrives early is
    // captured rather than dropped (baseline `theme:read`, §5.4).
    this.themeService = new ThemeService(this.messageBus);
    // Editor context (the dirty set, §5.3) — captured early so an `editor-context`
    // message arriving before the bundler exists isn't dropped. Elevated
    // `editor:read`; the parent only sends it to iframes that hold the capability.
    this.editorContextService = new EditorContextService(this.messageBus);
    // Method catalog (§5.5) — captured early; baseline catalog:read.
    this.catalogService = new CatalogService(this.messageBus);
    // Form factor of the rendered surface, for responsive app layout (§5.4.1).
    this.formFactorService = new FormFactorService(this.messageBus);
    // Descriptor cache for mounts the parent announces. The actual zenfs
    // mount/umount of the transferred port is done in `handleParentMessage`.
    this.mountService = new MountService();

    // Bridge immutable module fetches to the parent's persistent cache. This
    // iframe's opaque origin has no CacheStorage of its own; the parent
    // answers over `protocol-immutable-fetch` (see sandpack-client's
    // immutable-fetch-protocol.ts). Only consulted by retryFetch for
    // registered immutable URL prefixes, with a timeout fallback to a direct
    // fetch when the parent predates the protocol.
    registerParentImmutableFetch(
      (url) =>
        this.messageBus.protocolRequest('immutable-fetch', 'fetch', [url]) as Promise<ParentImmutableFetchResult>,
    );

    this.readyPromise = this.bootstrap().catch((err) => {
      logger.error('Failed to bootstrap sandpack instance', err);
      throw err;
    });
  }

  private async bootstrap() {
    // Set up the compile/refresh handler immediately so any 'compile' message
    // that arrives while we wait for the port is queued, not dropped.
    const disposeOnMessage = this.messageBus.onMessage((msg) => {
      this.handleParentMessage(msg);
    });
    this.disposableStore.add(disposeOnMessage);

    // Send 'initialized' now — the parent waits for this before it sends
    // 'register-frame' with the MessagePort in the transferable list.
    this.messageBus.sendMessage('initialized');

    // Wait for the MessagePort transferred in the 'register-frame' handshake.
    // Any `fs.promises.*` call in the iframe will be forwarded to the parent
    // via zenfs's Port RPC.
    const fsPort = await this.messageBus.getFsPort();

    // Registration is complete (the fs port rides on `register-frame`, so
    // `parentId` is now set). Ask the parent to push the current auth state, in
    // case it settled before we were listening. The parent also pushes
    // unprompted on every change.
    this.messageBus.sendMessage(REQUEST_AUTH_STATE_MESSAGE);
    // Ask the parent to push the current host theme too.
    this.messageBus.sendMessage(REQUEST_THEME_MESSAGE);
    this.messageBus.sendMessage(REQUEST_EDITOR_CONTEXT_MESSAGE);
    this.messageBus.sendMessage(REQUEST_CATALOG_MESSAGE);
    // ...and the current form factor.
    this.messageBus.sendMessage(REQUEST_FORM_FACTOR_MESSAGE);
    // Likewise ask the parent to (re-)announce any mounts that already exist.
    this.messageBus.sendMessage(REQUEST_MOUNTS_MESSAGE);

    // The zenfs `Port` backend accepts any WebMessagePort-shaped object; the
    // DOM `MessagePort` satisfies this structurally even though TS's union
    // also includes `WebSocket`.


    await configure({
      onlySyncOnClose: true,
      disableAccessChecks: true,
      disableAsyncCache: true,
      log: {
        enabled: true,
        level: "debug",
        dumpBacklog: true,
        output: console.debug
      }
    });
    // Generous RPC timeout: each `fs.*` call here is an RPC round-trip to the
    // parent, served on the parent's main thread. During rapid edits the parent
    // is busy (React re-renders, editor work), so a tight timeout makes reads
    // spuriously time out — and the late response then throws "Invalid RPC id"
    // (a timed-out request is removed before its response arrives), breaking the
    // preview. 30s is a safety net for genuinely lost messages, not normal load.
    const portfs = await resolveMountConfig({ backend: Port, port: fsPort as any, disableAsyncCache: true, timeout: 30000 });
    portfs.attributes.set('no_atime', true);
    await materializeMountPoint(APP_ROOT);
    mount(APP_ROOT, portfs);

    // Expose the shared filesystem to code running in the sandbox, rooted at the
    // project root (so `/app/src/App.tsx` maps to the parent's
    // `/repository/${provider}/${namespace}/${repository}/${ref}/src/App.tsx`). The
    // preloaded `fs` module re-exports this, so an app's `fs.promises.writeFile`
    // goes to the parent over the Port — which the parent observes at its
    // `attachFS` hook and reflects in the editor. Async APIs only: the Port
    // bridge is request/response and can't service synchronous fs calls.
    (globalThis as any).__sandpackSharedFs = bindContext({
      root: '/',
      pwd: APP_ROOT,
    }).fs;

    // Zenfs is ready — safe to create the bundler (ZenFSLayer starts a
    // filesystem watcher that requires zenfs to be configured).
    this.bundler = new Bundler({
      messageBus: this.messageBus,
      auth: this.authService,
      theme: this.themeService,
      editorContext: this.editorContextService,
      catalog: this.catalogService,
      formFactor: this.formFactorService,
      mounts: this.mountService,
    });

    this.bundler.onStatusChange((newStatus) => {
      this.messageBus.sendMessage('status', { status: newStatus });
    });

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

    // Bootstrap config (template/logLevel) was delivered on the same
    // `register-frame` message that gave us the fs port, so this resolves
    // immediately. There is no `compile` message anymore — the bundler drives
    // its own initial build and rebuilds when the parent relays an `fs-change`.
    const initConfig = await this.messageBus.getInitConfig();
    if (initConfig.logLevel != null) {
      logger.setLogLevel(initConfig.logLevel);
    }
    this.template = initConfig.template;

    // Kick off the initial compile.
    this.compileDebouncer.debounce(() => this.runCompile());
  }

  handleParentMessage(message: any) {
    switch (message.type) {
      case 'fs-change':
        // The parent observed writes to the shared filesystem and relayed the
        // changed paths (zenfs's Port backend can't forward watch events, so we
        // can't see them ourselves). The parent reports them repo-relative
        // (`/index.tsx`); the bundler fs is rooted at `/`, so anchor them to
        // `APP_ROOT`. Gate on `readyPromise` so changes relayed during bootstrap
        // (before the bundler exists) are applied once it's ready rather than
        // throwing.
        this.readyPromise
          .then(() => {
            const paths = (message.paths ?? []).map((p: string) => underAppRoot(p));
            this.bundler.markFilesChanged(paths);
            this.compileDebouncer.debounce(() => this.runCompile());
          })
          .catch(logger.error);
        break;
      case MOUNT_ADD_MESSAGE:
        this.readyPromise.then(() => this.handleMountAdd(message)).catch(logger.error);
        break;
      case MOUNT_REMOVE_MESSAGE:
        this.readyPromise.then(() => this.handleMountRemove(message)).catch(logger.error);
        break;
      case 'refresh':
        window.location.reload();
        this.messageBus.sendMessage('refresh');
        break;
    }
  }

  // The parent announced a new mount and transferred a `MessagePort` for its
  // filesystem (surfaced as `message.ports` by `IFrameParentMessageBus`). Mount
  // it at the descriptor's absolute path so app code can read/write it, then
  // record the descriptor for polling/subscription.
  private async handleMountAdd(message: any): Promise<void> {
    const mountDescriptor: SandboxMount | undefined = message.mount;
    const port: MessagePort | undefined = message.ports && message.ports[0];
    if (!mountDescriptor || !port) {
      logger.error('mount-add missing descriptor or port', message);
      return;
    }
    port.start();
    const mountfs = await resolveMountConfig({
      backend: Port,
      port: port as any,
      disableAsyncCache: true,
      timeout: 30000,
    });
    mountfs.attributes.set('no_atime', true);
    // Re-mounting the same path: drop the previous mount first.
    try {
      umount(mountDescriptor.path);
    } catch {
      /* not previously mounted — fine */
    }
    await materializeMountPoint(mountDescriptor.path);
    mount(mountDescriptor.path, mountfs);
    this.mountService.add(mountDescriptor);
  }

  private async handleMountRemove(message: any): Promise<void> {
    const id: string | undefined = message.id;
    const path: string | undefined = message.path;
    const target = this.mountService.getMounts().find((m) => (m.id ?? m.path) === (id ?? path));
    const mountPath = target?.path ?? path;
    if (!mountPath) {
      logger.error('mount-remove missing id/path', message);
      return;
    }
    try {
      umount(mountPath);
      // Drop the placeholder directory materialized at mount time so the
      // unmounted path doesn't linger as an empty dir in listings.
      // Non-recursive on purpose: if anything was written here outside the
      // mount's lifetime, leave it alone.
      await fs.promises.rmdir(mountPath).catch(() => {
        /* not empty or already gone — fine */
      });
    } catch (err) {
      logger.error(`Failed to umount ${mountPath}`, err);
    }
    this.mountService.remove(id ?? mountPath);
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

  private async runCompile() {
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
    await this.bundler.initPreset(this.template);
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
    await this.bundler.replaceHTML();

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
