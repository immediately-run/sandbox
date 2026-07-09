import { HELPER_PATH } from '@immediately-run/transpiler';

import {
  createBundlerHarness,
  EVAL_FIXTURE,
  installEvalGlobals,
} from '../../testHarness/bundlerHarness';

// Regression guard for the pre-transpiled-artifact consumption bug (2026-07-09):
// the react-refresh HMR helper must be materialized at BOOT (during preset init),
// not only inside a live `transform()`. A pre-transpiled artifact served by the
// §5.3 consult-HIT early-return SKIPS the whole transformer chain — including the
// react-refresh transformer — yet its emitted code still `require(HELPER_PATH)`.
// If the helper is only written during transform, a consumed react-refresh artifact
// crashes with "Cannot find module '/node_modules/__csb_bust/refresh-helper.js'".
// This never surfaced only because the artifact cache was version-inert on prod;
// activating it broke every react-refresh app. See the [[pretranspiled-artifact-
// consumption-broken]] memory.
describe('react-refresh helper materialized at boot (consult-HIT fix)', () => {
  it('writes HELPER_PATH during initPreset, before any module is transformed', async () => {
    const restore = installEvalGlobals();
    // `forCompile` runs `initPreset('create-react-app')` (→ ReactRefreshTransformer.init)
    // but does NOT compile — so no module has hit the transform chain yet. The helper
    // the consult-HIT path depends on must already exist.
    const h = await createBundlerHarness(EVAL_FIXTURE, { forCompile: true });
    try {
      expect(await h.bundler.fs.isFileAsync(HELPER_PATH)).toBe(true);
    } finally {
      await h.teardown();
      restore();
    }
  }, 60000);
});
