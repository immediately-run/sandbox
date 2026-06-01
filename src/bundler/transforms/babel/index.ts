import type { Bundler } from '../../bundler';
import { CompilationError } from '../../../errors/CompilationError';
import * as logger from '../../../utils/logger';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';
import type { ITransformData } from './babel-worker';

export class BabelTransformer extends Transformer {
  private messageBus: null | WorkerMessageBus = null;

  constructor() {
    super('babel-transformer');
  }

  async init(bundler: Bundler) {
    // The Babel worker runs in the *parent* page, not this (now opaque-origin)
    // iframe — an opaque origin can't load a same-origin worker script. The
    // parent transfers a `MessagePort` connected to that worker via the
    // `register-frame` handshake; we drive it with the same `WorkerMessageBus`
    // protocol the worker speaks, since a `MessagePort` is a valid endpoint.
    const port = await bundler.messageBus.getBabelPort();
    port.start();

    this.messageBus = new WorkerMessageBus({
      channel: 'sandpack-babel',
      endpoint: port,
      handleNotification: () => Promise.resolve(),
      handleRequest: () => Promise.reject(new Error('Unknown method')),
      handleError: (err) => {
        logger.error(err);
        return Promise.resolve();
      },
      timeoutMs: 30000,
    });
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    if (!this.messageBus) {
      throw new Error('Babel worker has not been initialized');
    }

    const data: ITransformData = {
      code: ctx.code,
      filepath: ctx.module.filepath,
      config,
    };

    try {
      return await this.messageBus.request('transform', data);
    } catch (err: unknown) {
      return new CompilationError(err as Error, ctx.module.filepath);
    }
  }
}
