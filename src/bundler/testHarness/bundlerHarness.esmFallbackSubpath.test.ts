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
 * are per-process, so a second boot cannot re-mount `/app`): each test targets
 * its OWN fixture entry/subpath pair and clears the loader's call log first.
 */
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

// The published `sql.js/dist/sql-asm.js` shape: an Emscripten-style CJS/UMD
// factory whose `require("node:child_process")` sits behind an isNode guard —
// the exact per-file isolation case R3-411 pinned for CDN-served files.
const RAW_SUBPATH_CJS = [
  '"use strict";',
  'var SQLite = function (options) { this.options = options; };',
  'SQLite.prototype.open = function () { return "db"; };',
  'if (typeof process !== "undefined" && process.versions && process.versions.node) {',
  '  try { require("node:child_process"); } catch (e) {}',
  '}',
  'if (typeof exports === "object") { exports["Module"] = SQLite; }',
  'else if (typeof define === "function" && define.amd) { define([], function () { return SQLite; }); }',
].join('\n');

const FIXTURE = {
  'package.json': JSON.stringify({
    name: 'subpath-fixture',
    main: 'src/index.ts',
    dependencies: { 'sql.js': '1.14.2' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  // Each entry imports a DIFFERENT subpath so every test materializes (or
  // misses) its own file against the shared registry — no cross-test coupling
  // through the `sql.js` file map.
  'src/index.ts': "const engine = import('sql.js/dist/sql-asm.js');\nexport default engine;\n",
  'src/second.ts': "const again = import('sql.js/dist/sql-asm.js');\nexport default again;\n",
  'src/esm.ts': "const esm = import('sql.js/dist/sql-wasm.js');\nexport default esm;\n",
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
  // …and the subpath rail serves the raw tarball file (unpkg in production).
  h.bundler.moduleRegistry.setEsmFallbackSubpathLoader(
    jest.fn<Promise<string>, [string, string, string]>().mockResolvedValue(RAW_SUBPATH_CJS),
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
    expect(entry.dependencyMap.get('sql.js/dist/sql-asm.js')).toBe('/node_modules/sql.js/dist/sql-asm.js');

    const subpathModule = h.bundler.getModule('/node_modules/sql.js/dist/sql-asm.js');
    expect(subpathModule).toBeDefined();
    // Published CJS is browser-ready as-is — byte-for-byte passthrough.
    expect(subpathModule!.compiled).toBe(RAW_SUBPATH_CJS);
    // The loader was asked for exactly the raw tarball coordinates.
    expect(subpathLoaderOf(h).mock.calls[0]).toEqual(['sql.js', '1.14.2', 'dist/sql-asm.js']);
    // R3-411 rides along: the guarded node: require maps to the stub, never fails the load.
    expect(subpathModule!.dependencyMap.get('node:child_process')).toBe(UNSUPPORTED_BUILTIN_MODULE_PATH);
  }, 60000);

  it('a second import of the same subpath resolves without re-fetching', async () => {
    subpathLoaderOf(h).mockClear();
    await h.bundler.transformModule(underAppRoot('/src/second.ts'));
    const second = await h.bundler.transformModule(underAppRoot('/src/second.ts'));
    expect(second.dependencyMap.get('sql.js/dist/sql-asm.js')).toBe('/node_modules/sql.js/dist/sql-asm.js');
    expect(subpathLoaderOf(h)).not.toHaveBeenCalled(); // file-map hit, no second fetch
  }, 60000);

  it('an ESM tarball file transpiles through the shared chain instead of passing through raw', async () => {
    const esmSource = 'export default function init () { return 42; }\n';
    subpathLoaderOf(h).mockClear().mockResolvedValue(esmSource);
    const entry = await h.bundler.transformModule(underAppRoot('/src/esm.ts'));
    expect(entry.dependencyMap.get('sql.js/dist/sql-wasm.js')).toBe('/node_modules/sql.js/dist/sql-wasm.js');
    const subpathModule = h.bundler.getModule('/node_modules/sql.js/dist/sql-wasm.js')!;
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
    subpathLoaderOf(h).mockClear().mockResolvedValue(RAW_SUBPATH_CJS);
    // sql.js is a fallback package; react is not — its subpath miss must not
    // trigger a materialization attempt.
    await expect(h.bundler.resolveAsync('react/not-a-file.js', underAppRoot('/src/index.ts'))).rejects.toThrow(
      ModuleNotFoundError,
    );
    expect(subpathLoaderOf(h)).not.toHaveBeenCalled();
  }, 60000);
});
