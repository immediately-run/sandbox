/**
 * R3-820 [harness] — the esm.sh fallback's DEEP SUBPATH rail. A package the
 * primary CDN drops is synthesized at its ROOT only
 * (`synthesizeEsmFallbackModule`), so an app importing `name/sub` (sqlite-studio
 * imports `sql.js/dist/sql-asm.js`) failed resolution with `Cannot find module`
 * even though the root fallback loaded — the live defect that kept the R3-820
 * drill's DB from ever loading. The fix: on a failed resolution of a bare
 * subpath of a fallback package, materialize the raw tarball file from unpkg
 * (published CJS passes through byte-for-byte with its require() graph scanned —
 * the raw-cjs convention), drop the CachedFS negative the failed probe left,
 * and retry the resolution once.
 *
 * Network boundaries (primary CDN manifest, esm.sh root source, unpkg subpath
 * file) are stubbed; the fallback synthesis, the transpile-through chain, the
 * resolver, the RegistryFS file map and the R3-411 dep-stub mapping run for real.
 *
 * One harness for the whole file (the suite's convention — ZenFS mount points
 * are per-process, so a second boot cannot re-mount `/app`). The byte-for-byte
 * case serves the REAL published sql.js@1.14.2 dist file vendored under
 * fixtures/sqljs (the same bytes bundlerHarness.sqljs.test.ts compiles), not a
 * hand-typed lookalike; the second-import entry lives in a DIFFERENT directory
 * than the first so the per-compile resolution cache cannot satisfy it and the
 * file-map dedup path is what runs.
 */
import * as fs from 'fs';
import * as path from 'path';

import { underAppRoot } from '../../fsLayout';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';
import { UNSUPPORTED_BUILTIN_MODULE_PATH } from '../shims';
import { ModuleNotFoundError } from '../../errors/ModuleNotFound';
import { fetchManifest, fetchModule } from '../module-registry/module-cdn';

jest.mock('../module-registry/module-cdn', () => ({
  ...jest.requireActual('../module-registry/module-cdn'),
  fetchManifest: jest.fn(),
  fetchModule: jest.fn(),
}));

const mockedFetchManifest = fetchManifest as jest.MockedFunction<typeof fetchManifest>;
const mockedFetchModule = fetchModule as jest.MockedFunction<typeof fetchModule>;

// The published sql.js@1.14.2 `dist/sql-wasm.js`, vendored verbatim under
// fixtures/sqljs (checked in — tests must not hit the network). Its guarded
// `require("node:fs")` / `require("node:crypto")` are the real per-file
// isolation case R3-411 pinned for CDN-served files.
const SQL_WASM_JS = fs.readFileSync(path.join(__dirname, 'fixtures', 'sqljs', 'sql-wasm.js'), 'utf8');

const FIXTURE = {
  'package.json': JSON.stringify({
    name: 'subpath-fixture',
    main: 'src/index.ts',
    dependencies: { 'sql.js': '1.14.2' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  // The byte-for-byte case and the dedup case import the REAL dist file; the
  // dedup entry sits in a nested dir so its resolution cache key differs.
  'src/index.ts': "const engine = import('sql.js/dist/sql-wasm.js');\nexport default engine;\n",
  'src/nested/second.ts': "const again = import('sql.js/dist/sql-wasm.js');\nexport default again;\n",
  // The ESM-transpile case uses the other dist name — its own subpath, so the
  // file map never conflates it with the CJS case.
  'src/esm.ts': "const esm = import('sql.js/dist/sql-asm.js');\nexport default esm;\n",
  // The concurrent pair shares one subpath from two directories (different
  // dirs → different resolution-cache keys, so BOTH resolutions run and fail
  // before the file exists, both enter the retry hook, and exactly ONE unpkg
  // fetch may serve them — the in-flight dedup). Same-dir entries would alias
  // on the per-dir resolution cache and one would eat the other's rejection.
  'src/conc-a.ts': "const a = import('sql.js/dist/concurrent.js');\nexport default a;\n",
  'src/nested2/conc-b.ts': "const b = import('sql.js/dist/concurrent.js');\nexport default b;\n",
  'src/miss.ts': "const miss = import('sql.js/dist/nope.js');\nexport default miss;\n",
};

let h: BundlerHarness;

beforeAll(async () => {
  h = await createBundlerHarness(FIXTURE, { forCompile: false });
  await h.bundler.initPreset('create-react-app');
  // Primary CDN drops sql.js entirely (the live `Package version not found`).
  mockedFetchManifest.mockReset();
  mockedFetchModule.mockReset();
  mockedFetchManifest.mockResolvedValue([]);
  mockedFetchModule.mockResolvedValue({ f: {}, m: [] });
  // esm.sh serves the package ROOT as a self-contained ESM module…
  h.bundler.moduleRegistry.setEsmFallbackFetcher(async () => 'export const anything = 1;');
  // …and the subpath rail serves the raw tarball file (unpkg in production;
  // here the vendored published bytes).
  h.bundler.moduleRegistry.setEsmFallbackSubpathLoader(
    jest.fn<Promise<string>, [string, string, string]>().mockResolvedValue(SQL_WASM_JS),
  );
  await h.bundler.moduleRegistry.fetchManifest({ 'sql.js': '1.14.2' });
  await h.bundler.moduleRegistry.preloadModules();
});

afterAll(async () => {
  await h.teardown();
});

const subpathLoaderOf = (harness: BundlerHarness) =>
  harness.bundler.moduleRegistry['esmFallbackSubpathLoader'] as jest.MockedFunction<
    (name: string, range: string, subpath: string) => Promise<string>
  >;

describe('R3-820 — esm.sh-fallback deep subpaths materialize and resolve', () => {
  it('a bare subpath of a fallback package resolves after materialization, CJS byte-for-byte', async () => {
    subpathLoaderOf(h).mockClear();
    expect(h.bundler.moduleRegistry.hasEsmFallback('sql.js')).toBe(true);
    const entry = await h.bundler.transformModule(underAppRoot('/src/index.ts'));
    // The dynamic import resolved to the materialized file, not an error.
    expect(entry.dependencyMap.get('sql.js/dist/sql-wasm.js')).toBe('/node_modules/sql.js/dist/sql-wasm.js');

    const subpathModule = h.bundler.getModule('/node_modules/sql.js/dist/sql-wasm.js');
    expect(subpathModule).toBeDefined();
    // Published CJS is browser-ready as-is — byte-for-byte the vendored dist file.
    expect(subpathModule!.compiled).toBe(SQL_WASM_JS);
    // The loader was asked for exactly the raw tarball coordinates.
    expect(subpathLoaderOf(h).mock.calls[0]).toEqual(['sql.js', '1.14.2', 'dist/sql-wasm.js']);
    // R3-411 rides along: the real file's guarded node:fs / node:crypto requires
    // map to the stub, never failing the load.
    expect(subpathModule!.dependencyMap.get('node:fs')).toBe(UNSUPPORTED_BUILTIN_MODULE_PATH);
    expect(subpathModule!.dependencyMap.get('node:crypto')).toBe(UNSUPPORTED_BUILTIN_MODULE_PATH);
  }, 60000);

  it('a second import of the same subpath resolves without re-fetching', async () => {
    subpathLoaderOf(h).mockClear();
    // /src/nested/second.ts resolves from a DIFFERENT directory than /src, so
    // the per-compile resolution cache cannot answer — this is the ensure-
    // materialized early-return path, not a memoized resolution.
    const second = await h.bundler.transformModule(underAppRoot('/src/nested/second.ts'));
    expect(second.dependencyMap.get('sql.js/dist/sql-wasm.js')).toBe('/node_modules/sql.js/dist/sql-wasm.js');
    expect(subpathLoaderOf(h)).not.toHaveBeenCalled(); // file-map hit, no second fetch
  }, 60000);

  it('two CONCURRENT resolutions of one subpath share a single fetch (the in-flight dedup)', async () => {
    const CJS = 'module.exports = { concurrent: true };\n';
    let releaseFetch: (value: string) => void = () => {};
    const heldFetch = new Promise<string>((resolve) => {
      releaseFetch = resolve;
    });
    subpathLoaderOf(h)
      .mockClear()
      .mockImplementation(() => heldFetch);

    // Both entries transform concurrently; both resolutions fail while the file
    // is absent, both enter the retry hook, and both call ensure — the FIRST
    // starts the materialization (its promise lives in the dedup map until it
    // settles), the SECOND must receive that same in-flight promise, not start
    // a second unpkg fetch. The barrier POLLS the ensure spy until both callers
    // have entered (no wall-clock sleep to mis-synchronize on a loaded machine).
    const ensureCalls = jest.spyOn(h.bundler.moduleRegistry, 'ensureEsmFallbackSubpath');
    const both = Promise.all([
      h.bundler.transformModule(underAppRoot('/src/conc-a.ts')),
      h.bundler.transformModule(underAppRoot('/src/nested2/conc-b.ts')),
    ]);
    for (let i = 0; i < 500 && ensureCalls.mock.calls.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10)); // both are parked on the held fetch
    }
    expect(ensureCalls.mock.calls.length).toBe(2); // BOTH callers entered the hook
    expect(subpathLoaderOf(h).mock.calls.length).toBe(1); // one in-flight fetch
    releaseFetch(CJS);
    const [a, b] = await both;
    ensureCalls.mockRestore();
    expect(a.dependencyMap.get('sql.js/dist/concurrent.js')).toBe('/node_modules/sql.js/dist/concurrent.js');
    expect(b.dependencyMap.get('sql.js/dist/concurrent.js')).toBe('/node_modules/sql.js/dist/concurrent.js');
    expect(subpathLoaderOf(h).mock.calls.length).toBe(1); // still one fetch after both settled
  }, 60000);

  it('ensureEsmFallbackSubpath is idempotent: a re-entry after materialization returns true with no fetch', async () => {
    subpathLoaderOf(h).mockClear();
    // dist/sql-wasm.js was materialized by the first test — the hook's contract
    // is that a later ensure (e.g. a concurrent straggler arriving after the
    // dedup entry was reaped) answers true from the file map, fetch-free.
    await expect(h.bundler.moduleRegistry.ensureEsmFallbackSubpath('sql.js', 'dist/sql-wasm.js')).resolves.toBe(true);
    expect(subpathLoaderOf(h)).not.toHaveBeenCalled();
    // And a subpath whose fetch fails is NOT claimed as materialized (the
    // mock's standing implementation must not leak a success into this case).
    subpathLoaderOf(h)
      .mockClear()
      .mockImplementation(async () => {
        throw new Error('HTTP 404 fetching unpkg sql.js@1.14.2/dist/never.js');
      });
    await expect(h.bundler.moduleRegistry.ensureEsmFallbackSubpath('sql.js', 'dist/never.js')).resolves.toBe(false);
  }, 60000);

  it('an ESM tarball file transpiles through the shared chain instead of passing through raw', async () => {
    const esmSource = 'export default function init () { return 42; }\n';
    subpathLoaderOf(h).mockClear().mockResolvedValue(esmSource);
    const entry = await h.bundler.transformModule(underAppRoot('/src/esm.ts'));
    expect(entry.dependencyMap.get('sql.js/dist/sql-asm.js')).toBe('/node_modules/sql.js/dist/sql-asm.js');
    const subpathModule = h.bundler.getModule('/node_modules/sql.js/dist/sql-asm.js')!;
    // ESM cannot run in the CJS require-runtime: the compiled form is transpiled,
    // not the raw `export default` source.
    expect(subpathModule.compiled).not.toBe(esmSource);
    expect(subpathModule.compiled).not.toMatch(/export default/);
  }, 60000);

  it('a subpath the tarball does not carry keeps the original resolution error', async () => {
    subpathLoaderOf(h).mockClear().mockRejectedValue(new Error('HTTP 404 fetching unpkg sql.js@1.14.2/dist/nope.js'));
    const entry = await h.bundler.transformModule(underAppRoot('/src/miss.ts'));
    // The compile boundary records the resolution miss (Module.compile absorbs it).
    expect(entry.compilationError).toBeInstanceOf(ModuleNotFoundError);
    expect(String(entry.compilationError)).toMatch(/sql\.js\/dist\/nope\.js/);
    // And a direct resolution keeps the ModuleNotFoundError shape, not a fetch error.
    await expect(h.bundler.resolveAsync('sql.js/dist/nope.js', underAppRoot('/src/miss.ts'))).rejects.toThrow(
      ModuleNotFoundError,
    );
  }, 60000);

  it('a subpath of a NON-fallback package never consults the loader', async () => {
    subpathLoaderOf(h).mockClear().mockResolvedValue(SQL_WASM_JS);
    // sql.js is a fallback package; react is not — its subpath miss must not
    // trigger a materialization attempt.
    await expect(h.bundler.resolveAsync('react/not-a-file.js', underAppRoot('/src/index.ts'))).rejects.toThrow(
      ModuleNotFoundError,
    );
    expect(subpathLoaderOf(h)).not.toHaveBeenCalled();
  }, 60000);
});
