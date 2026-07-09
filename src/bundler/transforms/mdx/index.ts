import { Bundler } from '../../bundler';
import { BundlerError } from '../../../errors/BundlerError';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

// The MDX compile + its frontmatter strip live in @immediately-run/transpiler
// (MDX_CONTENT_COLLECTIONS_SPEC §1.1), so the live transpile is byte-identical to
// the CLI's pre-transpiled artifacts (which run the same `compileMdx` via
// `transformFile`). As of R3-150 the compile no longer runs IN this iframe: it runs
// in the parent-owned transform worker (which is now esbuild-built and so can bundle
// the `@mdx-js/mdx` / unified tree Parcel couldn't). This stage is now a thin RPC —
// it sends `mdx-compile` over the SAME shared bus the `BabelTransformer` uses
// (`bundler.getBabelWorkerBus()`), keeping the three-stage chain
// (`mdx-transformer` → `babel-transformer` → `react-refresh-transformer`) intact.
//
// The compile emits the `@immediately-run/sdk/MDXProvider` provider import, the jsx
// runtime, and any in-body `import` as ordinary `import`s in its JS output; the
// SUBSEQUENT `babel-transformer` stage's dependency collector picks those up (and the
// CLI's `transformFile` collects the identical set into the artifact's `deps[]`), so
// this stage records no deps of its own.
export class MDXTransformer extends Transformer {
  private messageBus: null | WorkerMessageBus = null;

  constructor() {
    super('mdx-transformer');
  }

  async init(bundler: Bundler): Promise<void> {
    this.messageBus = await bundler.getBabelWorkerBus();
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    if (!this.messageBus) {
      throw new Error('MDX transformer has not been initialized');
    }
    try {
      const code: string = await this.messageBus.request('mdx-compile', {
        code: ctx.code,
        path: ctx.module.filepath,
      });
      return { code, dependencies: new Set([]) };
    } catch (e) {
      // The worker throws `MdxCompileError`; the transport serializes its own
      // `line`/`column` (spread into the wire error) and rebuilds a plain `Error`
      // carrying them, so `instanceof` no longer holds — read the fields directly.
      const err = new BundlerError(String((e as Error)?.message ?? e), ctx.module.filepath);
      const line = (e as { line?: number }).line;
      const column = (e as { column?: number }).column;
      if (typeof (e as Error)?.message === 'string') err.message = (e as Error).message;
      if (typeof line === 'number') err.line = line;
      if (typeof column === 'number') err.column = column;
      return err;
    }
  }
}
