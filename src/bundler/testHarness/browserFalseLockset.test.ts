import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeInputDepMap, rootRuntimeDependencies } from '@immediately-run/transpiler';

import { SandpackLogLevel, setLogLevel } from '../../utils/logger';
import { MANIFEST_SIDECAR_PATH, underAppRoot } from '../../fsLayout';
import {
  createBundlerHarness,
  COMPILE_FIXTURE,
  SELF_HOSTED_SDK_PACKAGE_JSON,
  type BundlerHarness,
} from './bundlerHarness';

/**
 * R3-1384 — a repo with a `browser: false` package still echo-matches the lockset the CLI
 * built from the same package.json. The CLI writes `computeInputDepMap(rootRuntimeDependencies(pkg))`
 * as the echo (immediately-run-cli `cacheZip.ts`); this test builds the sidecar with those
 * real transpiler functions, never a copy of the rule, and runs the real `loadNodeModules`
 * (the `sdkPeers.test.ts` seam: `parsedPackageJSON` set, the live path spied).
 */
describe('R3-1384 — browser:false and the sidecar lockset', () => {
  type Resolved = { n: string; v: string; d: number };
  const OMNIBOX_SIDECAR = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'sidecar', 'omnibox-55ca65d.sidecar.json'), 'utf-8'),
  ) as { lockset: { dependencies: Record<string, string>; resolved: Resolved[] } & Record<string, unknown> };
  /** omnibox's peers plus react-dom (so every SDK peer is declared) and a CLI-only package. */
  const PKG = {
    peerDependencies: { '@immediately-run/sdk': '>=0.60.0 <1.0.0', react: '^19.2.5', 'react-dom': '^19.2.5' },
    dependencies: { 'csv-parse': '^7.0.3' },
    browser: { 'csv-parse': false },
  };

  /** The sidecar the CLI writes for `pkg`: its echo from the shared transpiler functions. */
  const cliSidecar = (pkg: unknown): string =>
    JSON.stringify({
      ...OMNIBOX_SIDECAR,
      lockset: {
        ...OMNIBOX_SIDECAR.lockset,
        dependencies: computeInputDepMap(rootRuntimeDependencies(pkg as never)),
        resolved: [
          ...OMNIBOX_SIDECAR.lockset.resolved,
          { n: 'react-dom', v: '19.2.5', d: 0 },
          { n: 'scheduler', v: '0.27.0', d: 1 },
        ],
      },
    });

  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
    await h.bundler.fs.writeFile('/node_modules/@immediately-run/sdk/package.json', SELF_HOSTED_SDK_PACKAGE_JSON);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await h.teardown();
  });

  async function boot(pkg: unknown, sidecar: string) {
    await h.bundler.fs.writeFile(underAppRoot(MANIFEST_SIDECAR_PATH), sidecar);
    const b = h.bundler as unknown as {
      parsedPackageJSON: unknown;
      loadNodeModules: () => Promise<void>;
      moduleRegistry: {
        manifest: Resolved[];
        setEsmFallbackFetcher: (f: null) => void;
        resolveManifestGuarded: (deps: Record<string, string>) => Promise<Resolved[]>;
        preloadModules: () => Promise<void>;
        loadModuleDependencies: () => Promise<void>;
      };
    };
    b.parsedPackageJSON = pkg;
    await h.bundler.initPreset('create-react-app');
    const reg = b.moduleRegistry;
    reg.setEsmFallbackFetcher(null);
    let liveInput: Record<string, string> | undefined;
    jest.spyOn(reg, 'resolveManifestGuarded').mockImplementation(async (deps) => {
      liveInput = { ...deps };
      return Object.keys(deps).map((n) => ({ n, v: '0.0.0-stub', d: 0 }));
    });
    jest.spyOn(reg, 'preloadModules').mockImplementation(async () => undefined);
    jest.spyOn(reg, 'loadModuleDependencies').mockImplementation(async () => undefined);
    setLogLevel(SandpackLogLevel.Debug);
    const debug = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await b.loadNodeModules();
    const usedLockset = debug.mock.calls.some((c) => String(c[0]).includes('Using sidecar lockset'));
    return { usedLockset, liveInput, manifest: reg.manifest };
  }

  it('the CLI-built sidecar applies, and csv-parse is in neither the echo nor the manifest', async () => {
    const sidecar = cliSidecar(PKG);
    expect(JSON.parse(sidecar).lockset.dependencies).not.toHaveProperty('csv-parse');
    const { usedLockset, liveInput, manifest } = await boot(PKG, sidecar);
    expect(usedLockset).toBe(true);
    expect(liveInput).toBeUndefined();
    expect(manifest.some((r) => r.n === 'csv-parse')).toBe(false);
  });

  it('control: the same sidecar does not match a package.json without the browser field', async () => {
    const { browser: _dropped, ...withoutBrowser } = PKG;
    const { usedLockset, liveInput } = await boot(withoutBrowser, cliSidecar(PKG));
    expect(usedLockset).toBe(false);
    expect(liveInput?.['csv-parse']).toBe('^7.0.3');
  });
});
