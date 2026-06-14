import { Bundler } from '../bundler';
import type { AuthService } from '../../auth/AuthService';
import type { ThemeService } from '../../theme/ThemeService';
import type { EditorContextService } from '../../editor/EditorContextService';
import type { CatalogService } from '../../catalog/CatalogService';
import type { FormFactorService } from '../../formFactor/FormFactorService';
import type { MountService } from '../../mounts/MountService';
import type { IFrameParentMessageBus } from '../../protocol/iframe';

import { createBundlerFsHarness, type BundlerFsHarness } from './harness';
import { createBabelLoopback, type BabelLoopback } from './babelLoopback';

/**
 * R3-48 G0-0 (compile half, step 2) — boot the real `Bundler` in-process against the
 * harness mount table and drive its transpile pipeline. The bundler reads `/app`
 * through its `CachedFS` over the global zenfs tree (the harness's recorded `/app`
 * stand-in → the Port-traffic spy) and transpiles via the in-process babel loopback.
 * The 6 services are barely touched (only `getBabelPort` + a `sendMessage`), so they
 * are minimal stubs.
 *
 * SCOPE: the smoke drives `transformModule(entry)` — the bundler reading + transpiling
 * the entry module + its LOCAL import graph over the harness fs. Full `compile()`
 * additionally vendors the platform SDK (network) and injects the react-refresh HMR
 * runtime (`react-refresh/runtime` + react), i.e. needs the whole module environment —
 * out of scope for an in-process FS-routing/transpile smoke. And today's (pre-`G0-4`)
 * bundler resolves `/node_modules` via its own `NodeModuleFSLayer`/`moduleRegistry`,
 * not the mounted `RegistryFS`, so the "node_modules off the mount, zero `/app` Port
 * traffic" assertion belongs to the G0-4 flip (the network spy is staged for it).
 */

/** A local-only fixture: an entry `.ts` importing one local `.ts`. `.ts` files get the
 *  babel transform ONLY (no react-refresh HMR runtime — that is `.tsx`/`.jsx`-only,
 *  per ReactPreset.mapTransformers), and there is no JSX, so the transpile graph stays
 *  inside `/app` (no react/runtime/node_modules resolution). */
export const COMPILE_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'compile-fixture', main: 'src/index.ts' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import answer from './answer';\nexport default answer + 1;\n",
  'src/answer.ts': "const answer: number = 41;\nexport default answer;\n",
};

/** A full-`compile()` fixture: the entry follows the `src/main` convention the
 *  bundler's compile path expects, and stays JSX-free so the only node_modules
 *  dependency is the react-refresh HMR runtime (stubbed below). */
export const FULL_COMPILE_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'full-compile-fixture', main: 'src/main' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/main.ts': "import answer from './answer';\nexport default answer + 1;\n",
  'src/answer.ts': "const answer: number = 41;\nexport default answer;\n",
};

/** A no-op `react-refresh/runtime` stub so the HMR runtime the react preset injects
 *  RESOLVES at compile (the real HMR behavior is an evaluate-time concern, out of
 *  scope for a transpile/FS-routing compile smoke). */
const REACT_REFRESH_RUNTIME_STUB =
  'module.exports = { injectIntoGlobalHook(){}, register(){}, ' +
  'createSignatureFunctionForTransform(){ return function(){}; }, performReactRefresh(){}, ' +
  'isLikelyComponentType(){ return false; }, getFamilyByType(){}, setSignature(){}, ' +
  'collectCustomHooksForSignature(){} };';

const stub = <T,>(): T => ({}) as unknown as T;

export interface BundlerHarness extends BundlerFsHarness {
  bundler: Bundler;
  babel: BabelLoopback;
  /** Messages the bundler emitted via the messageBus double, by type. */
  sentMessages: Array<{ type: string; data?: unknown }>;
  teardown(): Promise<void>;
}

/** Boot a `Bundler` wired to the harness fs + an in-process babel loopback.
 *
 * `forCompile` makes the returned bundler ready for a full `compile()`: it no-ops the
 * platform SDK vendoring (`addLocalModules` → network, out of scope), runs
 * `initPreset('create-react-app')`, and injects the `react-refresh/runtime` stub the
 * preset's HMR runtime imports. Without it the harness is for the transpile path
 * (`transformModule`) — the caller drives `initPreset` itself. */
export async function createBundlerHarness(
  fixture: Record<string, string> = COMPILE_FIXTURE,
  opts: { forCompile?: boolean } = {},
): Promise<BundlerHarness> {
  const fsHarness = await createBundlerFsHarness(fixture);
  const babel = await createBabelLoopback();
  const sentMessages: Array<{ type: string; data?: unknown }> = [];

  // The bundler only calls `getBabelPort` (via BabelTransformer.init) + `sendMessage`
  // during a compile; the rest are inert stubs so the double satisfies the type.
  const messageBus = {
    getBabelPort: () => Promise.resolve(babel.babelPort),
    sendMessage: (type: string, data?: unknown) => sentMessages.push({ type, data }),
    onMessage: () => ({ dispose: () => {} }),
    getFsPort: () => Promise.resolve(undefined),
    getInitConfig: () => Promise.resolve({ template: 'react' }),
    protocolRequest: () => Promise.resolve(undefined),
  } as unknown as IFrameParentMessageBus;

  const bundler = new Bundler({
    messageBus,
    auth: stub<AuthService>(),
    theme: stub<ThemeService>(),
    editorContext: stub<EditorContextService>(),
    catalog: stub<CatalogService>(),
    formFactor: stub<FormFactorService>(),
    mounts: stub<MountService>(),
  });

  if (opts.forCompile) {
    // SDK vendoring fetches `@immediately-run/sdk` from the self-host origin (network,
    // no transport under jest) and is out of scope for an FS-routing/transpile compile.
    (bundler as unknown as { addLocalModules: () => Promise<void> }).addLocalModules = () => Promise.resolve();
    await bundler.initPreset('create-react-app');
    // The react preset's HMR runtime `require('react-refresh/runtime')` — resolve it.
    await bundler.addPreloadedModule('react-refresh/runtime', REACT_REFRESH_RUNTIME_STUB);
  }

  return {
    ...fsHarness,
    bundler,
    babel,
    sentMessages,
    teardown: async () => {
      babel.dispose();
      await fsHarness.teardown();
    },
  };
}
