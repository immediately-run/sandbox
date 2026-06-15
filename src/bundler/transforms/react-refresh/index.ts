import { Bundler } from '../../bundler';
import {
  getWrapperCode,
  HELPER_CODE,
  HELPER_PATH,
  REACT_REFRESH_RUNTIME,
} from '@immediately-run/transpiler';
import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

// The HMR wrapper bytes (HELPER_CODE, the prelude/postlude, REACT_REFRESH_RUNTIME)
// now live in @immediately-run/transpiler so a pre-transpiled artifact carries the
// exact same instrumentation as this live transpile (PRETRANSPILED_ARTIFACTS_SPEC
// §4.4). This module keeps only the Bundler wiring: materialising the helper file
// into the in-memory fs and registering the runtime.

export class ReactRefreshTransformer extends Transformer {
  constructor() {
    super('react-refresh-transformer');
  }

  async init(bundler: Bundler): Promise<void> {
    await bundler.registerRuntime(this.id, REACT_REFRESH_RUNTIME);
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    // TODO: Detect if we need to add react-refresh to this file...

    // Write helper to memory-fs
    if (!(await ctx.module.bundler.fs.isFileAsync(HELPER_PATH))) {
      await ctx.module.bundler.fs.writeFile(HELPER_PATH, HELPER_CODE);
    }

    const newCode = getWrapperCode(ctx.code);
    return {
      code: newCode || '',
      dependencies: new Set([HELPER_PATH]),
    };
  }
}
