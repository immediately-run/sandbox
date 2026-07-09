import type { Bundler } from '../../bundler';
import { CompilationError } from '../../../errors/CompilationError';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';
import type { ITransformData } from './babel-worker';

export class BabelTransformer extends Transformer {
  private messageBus: null | WorkerMessageBus = null;

  constructor() {
    super('babel-transformer');
  }

  async init(bundler: Bundler) {
    // The transform worker runs in the *parent* page, not this (now opaque-origin)
    // iframe — an opaque origin can't load a same-origin worker script. The parent
    // transfers a `MessagePort` connected to that worker via the `register-frame`
    // handshake. The bus over that port is shared with the `MDXTransformer`
    // (both speak `WorkerMessageBus` to the one worker), so it lives on the bundler.
    this.messageBus = await bundler.getBabelWorkerBus();
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
