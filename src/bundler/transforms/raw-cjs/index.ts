import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';
import { scanCjsModule } from './scan';

/**
 * Pass-through transformer for CommonJS `/node_modules` sources.
 *
 * Published npm packages are browser-ready, and the Sandpack CDN serves only
 * their dependency graph (it does not transform code). Running them through the
 * Babel chain therefore buys nothing but cost: `@babel/preset-env` with
 * `useBuiltIns:'usage'` re-scans every dependency for polyfills, injects
 * `require('core-js/...')`, and lowers the (often large) bundle — the multi-second
 * first-load tax this transformer removes. Babel stays reserved for app source.
 *
 * The runtime is a CommonJS require-system, so the only thing the bundler needs
 * from a dependency is its `require()` graph — collected here by {@link
 * scanCjsModule} (mirroring the require-only Babel dep-collector). The code is
 * returned byte-for-byte unchanged. ESM dependencies do NOT reach this
 * transformer: {@link ./scan.isPassthroughCjs} keeps them on the Babel ESM→CJS
 * path (the CJS runtime can't evaluate `import`/`export`).
 */
export class RawCjsTransformer extends Transformer {
  constructor() {
    super('raw-cjs-transformer');
  }

  async transform(ctx: ITranspilationContext): Promise<ITranspilationResult> {
    const { requires } = scanCjsModule(ctx.code);
    return { code: ctx.code, dependencies: new Set(requires) };
  }
}
