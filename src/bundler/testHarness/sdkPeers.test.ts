import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SandpackLogLevel, setLogLevel } from '../../utils/logger';
import { MANIFEST_SIDECAR_PATH, underAppRoot } from '../../fsLayout';
import {
  createBundlerHarness,
  COMPILE_FIXTURE,
  SELF_HOSTED_SDK_PACKAGE_JSON,
  type BundlerHarness,
} from './bundlerHarness';

/**
 * R3-1318 at the `loadNodeModules` seam, driven the way `rootPeers.test.ts` drives it
 * (`parsedPackageJSON` set directly; `fetchManifest` spied, no network). The vendored
 * SDK manifest is written where `vendorModuleFrom` writes it, with the bytes production
 * writes there: the recorded self-host manifest for the default SDK 0.16.0, which has
 * no `peerDependencies`. The peers therefore come from `IMPLICIT_SDK_PEERS`; the drift
 * guard pinning that constant to the npm SDK's peers is in `selfHostPeers.test.ts`.
 *
 * Before the change, (a) sent no react and (c) never reached `fetchManifest`. Removing
 * the `IMPLICIT_SDK_PEERS` fallback fails (a) and (c).
 */
describe('R3-1318 — the implicit SDK brings its peers', () => {
  const SDK_MANIFEST_PATH = '/node_modules/@immediately-run/sdk/package.json';

  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, SELF_HOSTED_SDK_PACKAGE_JSON);
  });

  afterEach(async () => {
    await h.teardown();
  });

  /** Drive the real `loadNodeModules` with the app's package.json replaced by `pkg`;
   *  the dependency map sent to the CDN, or undefined when no query was made. */
  async function depsSentToCdn(pkg: unknown): Promise<Record<string, string> | undefined> {
    (h.bundler as unknown as { parsedPackageJSON: unknown }).parsedPackageJSON = pkg;
    await h.bundler.initPreset('create-react-app');
    const registry = (
      h.bundler as unknown as {
        moduleRegistry: { fetchManifest: (...a: unknown[]) => Promise<unknown> };
      }
    ).moduleRegistry;
    let sent: Record<string, string> | undefined;
    const spy = jest.spyOn(registry, 'fetchManifest').mockImplementation(async (deps: unknown) => {
      sent = { ...(deps as Record<string, string>) };
    });
    try {
      await (h.bundler as unknown as { loadNodeModules: () => Promise<void> }).loadNodeModules();
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  it('(a) the self-host manifest and a root declaring only jose (baton) send react and react-dom at ^19.0.0', async () => {
    const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
    expect(sent?.jose).toBe('^6.2.12');
    expect(sent?.react).toBe('^19.0.0');
    expect(sent?.['react-dom']).toBe('^19.0.0');
  });

  it('(b) a vendored manifest that declares peerDependencies wins over IMPLICIT_SDK_PEERS', async () => {
    const declaring = { ...JSON.parse(SELF_HOSTED_SDK_PACKAGE_JSON), peerDependencies: { react: '^20.0.0' } };
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, JSON.stringify(declaring));
    const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
    expect(sent?.react).toBe('^20.0.0');
    expect(sent?.['react-dom']).toBeUndefined();
  });

  it("(c) a root declaring react keeps its own range over the SDK's", async () => {
    const sent = await depsSentToCdn({ dependencies: { react: '^18.3.0' } });
    expect(sent?.react).toBe('^18.3.0');
    expect(sent?.['react-dom']).toBe('^19.0.0');
  });

  it("(c) the root's range also wins over a manifest-declared peer", async () => {
    const declaring = { ...JSON.parse(SELF_HOSTED_SDK_PACKAGE_JSON), peerDependencies: { react: '^20.0.0' } };
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, JSON.stringify(declaring));
    const sent = await depsSentToCdn({ peerDependencies: { react: '^18.3.0' } });
    expect(sent?.react).toBe('^18.3.0');
  });

  it('a manifest with no dependencies key still queries the CDN with the peers', async () => {
    const sent = await depsSentToCdn({});
    expect(sent).toBeDefined();
    expect(sent?.react).toBe('^19.0.0');
    expect(sent?.['react-dom']).toBe('^19.0.0');
  });

  it("a git library's differing react range is reported as losing to the SDK's implicit peer, not an app pin", async () => {
    (
      h.bundler as unknown as { gitLibraryDependencies: Map<string, Record<string, string>> }
    ).gitLibraryDependencies.set('@scope/lib', { react: '^18.3.0' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
      expect(sent?.react).toBe('^19.0.0');
      const said = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("Git-library '@scope/lib'"));
      expect(said).toContain("the SDK's implicit peer react@^19.0.0");
      expect(said).not.toContain('the app pins');
    } finally {
      warn.mockRestore();
    }
  });

  it('the same clash against a root that declares react still says the app pins it', async () => {
    (
      h.bundler as unknown as { gitLibraryDependencies: Map<string, Record<string, string>> }
    ).gitLibraryDependencies.set('@scope/lib', { react: '^18.3.0' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await depsSentToCdn({ dependencies: { react: '^19.2.5' } });
      const said = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("Git-library '@scope/lib'"));
      expect(said).toContain('the app pins react@^19.2.5');
    } finally {
      warn.mockRestore();
    }
  });

  it('an unparseable vendored manifest contributes nothing and warns', async () => {
    await h.bundler.fs.writeFile(SDK_MANIFEST_PATH, '{ not json');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sent = await depsSentToCdn({ dependencies: { jose: '^6.2.12' } });
      expect(sent?.['react-dom']).toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes(SDK_MANIFEST_PATH))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * R3-1318 round 2: the SDK's peers against a cached sidecar lockset. The CLI's lockset
 * echo is computed over the root's runtime dependencies alone, and its lockset was
 * resolved without the SDK's peers. The fixture is the recorded zip sidecar of omnibox
 * at 55ca65d (its live gh-pages sidecar, recorded by the round-2 reviewer 2026-11-04):
 * its lockset carries react but not react-dom. These cases run the real `fetchManifest`;
 * only the live `/dep_tree/` call (`resolveManifestGuarded`) and the module loading after
 * it are stubbed.
 */
describe('R3-1318 — SDK peers and the sidecar lockset', () => {
  const OMNIBOX_SIDECAR = readFileSync(join(__dirname, 'fixtures', 'sidecar', 'omnibox-55ca65d.sidecar.json'), 'utf-8');
  /** omnibox's package.json at 55ca65d. */
  const OMNIBOX_PKG = { peerDependencies: { '@immediately-run/sdk': '>=0.60.0 <1.0.0', react: '^19.2.5' } };
  type Resolved = { n: string; v: string; d: number };

  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
    await h.bundler.fs.writeFile('/node_modules/@immediately-run/sdk/package.json', SELF_HOSTED_SDK_PACKAGE_JSON);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await h.teardown();
  });

  /** Run `loadNodeModules` over `pkg` with `sidecar` in place; report whether the lockset
   *  was applied, the map the live path was asked for (if it ran) and the manifest. */
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
    // `logger.debug` writes through `console.log` at the Debug level; pin the level so
    // the "Using sidecar lockset" line is observable.
    setLogLevel(SandpackLogLevel.Debug);
    const debug = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await b.loadNodeModules();
    const usedLockset = debug.mock.calls.some((c) => String(c[0]).includes('Using sidecar lockset'));
    return { usedLockset, liveInput, manifest: reg.manifest };
  }

  it('omnibox (declares react, not react-dom) skips the lockset and resolves react-dom through /dep_tree/', async () => {
    const { usedLockset, liveInput, manifest } = await boot(OMNIBOX_PKG, OMNIBOX_SIDECAR);
    expect(usedLockset).toBe(false);
    expect(liveInput?.['react-dom']).toBe('^19.0.0');
    expect(liveInput?.react).toBe('^19.2.5');
    expect(manifest.some((r) => r.n === 'react-dom')).toBe(true);
  });

  it('a root declaring react and react-dom at its own ranges still uses the sidecar lockset', async () => {
    // The omnibox sidecar as the CLI would write it for a root that also declares
    // react-dom: the same file with react-dom added to the echo and the resolved set.
    const sidecar = JSON.parse(OMNIBOX_SIDECAR) as {
      lockset: { dependencies: Record<string, string>; resolved: Resolved[] };
    };
    sidecar.lockset.dependencies['react-dom'] = '^19.2.5';
    sidecar.lockset.resolved.push({ n: 'react-dom', v: '19.2.5', d: 0 }, { n: 'scheduler', v: '0.27.0', d: 1 });
    const pkg = { peerDependencies: { ...OMNIBOX_PKG.peerDependencies, 'react-dom': '^19.2.5' } };

    const { usedLockset, liveInput, manifest } = await boot(pkg, JSON.stringify(sidecar));
    expect(usedLockset).toBe(true);
    expect(liveInput).toBeUndefined();
    expect(manifest.find((r) => r.n === 'react-dom')?.v).toBe('19.2.5');
  });
});
