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
    // Materialize the HMR helper at BOOT, not just during transform(). A
    // pre-transpiled artifact served by the §5.3 consult-HIT early-return skips the
    // whole transformer chain — including this transformer — yet its emitted code
    // still `require(HELPER_PATH)` (the wrap prelude). If the helper is only written
    // in transform(), a consumed react-refresh artifact crashes with
    // "Cannot find module '/node_modules/__csb_bust/refresh-helper.js'" — which
    // silently never surfaced only because the artifact cache was version-inert on
    // prod. Writing it here (idempotent) makes the seeding/consult path resolve it,
    // exactly like registerRuntime above already materializes the runtime at boot.
    await this.materializeHelper(bundler);
  }

  private async materializeHelper(bundler: Bundler): Promise<void> {
    if (!(await bundler.fs.isFileAsync(HELPER_PATH))) {
      await bundler.fs.writeFile(HELPER_PATH, HELPER_CODE);
    }
  }

  async transform(ctx: ITranspilationContext, config: any): Promise<ITranspilationResult> {
    // TODO: Detect if we need to add react-refresh to this file...

    // Belt-and-braces: init() already wrote the helper at boot; this keeps the live
    // path self-sufficient if a transform ever runs before init completes.
    await this.materializeHelper(ctx.module.bundler);

    const newCode = getWrapperCode(ctx.code);
    return {
      code: newCode || '',
      dependencies: new Set([HELPER_PATH]),
    };
  }
}
