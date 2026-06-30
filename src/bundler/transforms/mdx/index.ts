import { compileMdx, MdxCompileError } from '@immediately-run/transpiler';

import { Bundler } from '../../bundler';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';
import { BundlerError } from '../../../errors/BundlerError';

// The MDX compile (the `@mdx-js/mdx`/`remark-gfm`/`unified` pipeline + the
// frontmatter strip) now lives in @immediately-run/transpiler so the CLI can
// pre-transpile `.mdx` through the identical chain and the emitted bytes are
// byte-identical (MDX_CONTENT_COLLECTIONS_SPEC §1.1). This transformer is now a
// thin wrapper — the same shape `BabelTransformer` already has over
// `transformBabel` — keeping only the sandbox `BundlerError` translation.
//
// Dependencies stay an empty set here: the chain runs `babel-transformer` next
// (ReactPreset.mapTransformers), whose dep-collector records the provider /
// jsx-runtime / in-body imports the MDX compile emitted — unchanged from before.
export class MDXTransformer extends Transformer {
  constructor() {
    super('mdx-transformer');
  }

  async init(bundler: Bundler): Promise<void> {}

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    try {
      const code = await compileMdx(ctx.code, ctx.module.filepath);
      return {
        code,
        dependencies: new Set([]),
      };
    } catch (e) {
      const message = e instanceof MdxCompileError ? e.message : String(e);
      const err = new BundlerError(message, ctx.module.filepath);
      if (e instanceof MdxCompileError) {
        if (e.line !== undefined) err.line = e.line;
        if (e.column !== undefined) err.column = e.column;
      }
      return err;
    }
  }
}
