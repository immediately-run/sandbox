import { compileMdx, MdxCompileError } from '@immediately-run/transpiler';

import { Bundler } from '../../bundler';
import { BundlerError } from '../../../errors/BundlerError';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

// The MDX compile + its frontmatter strip now live in @immediately-run/transpiler
// (MDX_CONTENT_COLLECTIONS_SPEC §1.1), so the live transpile is byte-identical to
// the CLI's pre-transpiled artifacts (which run the same `compileMdx` via
// `transformFile`). This module keeps only the sandbox `Transformer` wiring: call
// the shared compile and re-wrap its typed error as a `BundlerError`.
//
// The chain stays three-stage: `mdx-transformer` → `babel-transformer` →
// `react-refresh-transformer` (ReactPreset.mapTransformers). The compile emits the
// `@immediately-run/sdk/MDXProvider` provider import, the jsx runtime, and any
// in-body `import` as ordinary `import`s in its JS output; the SUBSEQUENT
// `babel-transformer` stage's dependency collector picks those up (and the CLI's
// `transformFile` collects the identical set into the artifact's `deps[]`), so this
// stage records no deps of its own.
export class MDXTransformer extends Transformer {
  constructor() {
    super('mdx-transformer');
  }

  async init(bundler: Bundler): Promise<void> {}

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    try {
      const code = await compileMdx(ctx.code, ctx.module.filepath);
      return { code, dependencies: new Set([]) };
    } catch (e) {
      const err = new BundlerError(String(e), ctx.module.filepath);
      if (e instanceof MdxCompileError) {
        err.message = e.message;
        err.line = e.line;
        err.column = e.column;
      }
      return err;
    }
  }
}
