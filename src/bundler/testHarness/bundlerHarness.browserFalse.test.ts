/**
 * R3-1384 [harness] — the full boot with `"browser": { "csv-parse": false }` in the root
 * package.json: `compile()` runs `Bundler.loadNodeModules` (SDK peers, preset augmentation),
 * and the compiled graph EVALUATES. A module that imports `csv-parse` and `csv-parse/sync` at
 * top level runs, both resolve to the resolver's empty-module shim, and csv-parse is never requested from
 * the package CDN or the esm.sh fallback. Only the CDN and the esm.sh fetch are replaced. Its
 * own file because a harness mounts ZenFS at global points (one per file).
 */
import { createBundlerHarness, installEvalGlobals, type BundlerHarness } from './bundlerHarness';
import { fetchManifest, fetchModule } from '../module-registry/module-cdn';
import { EMPTY_SHIM } from '../../resolver/utils/constants';

jest.mock('../module-registry/module-cdn', () => ({
  ...jest.requireActual('../module-registry/module-cdn'),
  fetchManifest: jest.fn(),
  fetchModule: jest.fn(),
}));

const mockedFetchManifest = fetchManifest as jest.MockedFunction<typeof fetchManifest>;
const mockedFetchModule = fetchModule as jest.MockedFunction<typeof fetchModule>;

const FIXTURE = {
  'package.json': JSON.stringify({
    name: 'cli-with-docs',
    main: 'src/main',
    // `yaml` makes the manifest request happen, so "csv-parse is absent from it" is not vacuous.
    dependencies: { 'csv-parse': '^7.0.3', yaml: '^2.0.0' },
    browser: { 'csv-parse': false },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  // Top-level imports of the excluded package and a subpath of it.
  'src/main.ts':
    "import csv from 'csv-parse';\n" +
    "import * as sync from 'csv-parse/sync';\n" +
    // A deep subpath (csv-parse v4 documented `csv-parse/lib/sync`).
    "import 'csv-parse/lib/es5/sync.js';\n" +
    'const g = globalThis as Record<string, unknown>;\n' +
    'g.__browserFalseBooted = true;\n' +
    'g.__csvDefault = csv;\n' +
    'g.__csvSync = sync;\n' +
    'export default 1;\n',
};

const g = globalThis as Record<string, unknown>;
let h: BundlerHarness;
let restore: () => void;
let warn: jest.SpyInstance;
const esmUrls: string[] = [];

beforeAll(async () => {
  restore = installEvalGlobals();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockedFetchManifest.mockResolvedValue([]);
  mockedFetchModule.mockResolvedValue({ f: {}, m: [] });
  h = await createBundlerHarness(FIXTURE, { forCompile: true });
  h.bundler.moduleRegistry.setEsmFallbackFetcher(async (url) => {
    esmUrls.push(url);
    return 'export default {};\n';
  });
  const evaluate = await h.bundler.compile();
  g.__resolvedCsv = await h.bundler.resolveAsync('csv-parse', '/app/src/main.ts');
  g.__resolvedCsvSync = await h.bundler.resolveAsync('csv-parse/sync', '/app/src/main.ts');
  g.__resolvedCsvDeep = await h.bundler.resolveAsync('csv-parse/lib/es5/sync.js', '/app/src/main.ts');
  (evaluate as () => unknown)();
}, 120000);

afterAll(async () => {
  delete g.__browserFalseBooted;
  delete g.__csvDefault;
  delete g.__csvSync;
  delete g.__resolvedCsv;
  delete g.__resolvedCsvSync;
  delete g.__resolvedCsvDeep;
  warn.mockRestore();
  await h.teardown();
  restore();
});

describe('R3-1384 — compile() and evaluate with a browser:false dependency', () => {
  it('a module importing csv-parse and csv-parse/sync at top level evaluates', () => {
    expect(g.__browserFalseBooted).toBe(true);
  });

  it("both specifiers resolve to the resolver's empty-module shim", () => {
    expect(g.__resolvedCsv).toBe(EMPTY_SHIM);
    expect(g.__resolvedCsvSync).toBe(EMPTY_SHIM);
    expect(g.__resolvedCsvDeep).toBe(EMPTY_SHIM);
  });

  it('both imports yield the empty module, with no named exports', () => {
    // EMPTY_SHIM is `module.exports = () => {}`, the shim every `browser: false` mapping
    // already uses; R3-1384 does not change it (see the PR body).
    expect(typeof g.__csvDefault).toBe('function');
    // A namespace import of a CommonJS module: interop may add `default`/`__esModule`, nothing else.
    const names = Object.keys(g.__csvSync as object).filter((k) => k !== 'default' && k !== '__esModule');
    expect(names).toEqual([]);
  });

  it('csv-parse is never requested from the package CDN or the esm.sh fallback', () => {
    expect(mockedFetchManifest).toHaveBeenCalled();
    expect(JSON.stringify(mockedFetchManifest.mock.calls)).toContain('yaml');
    for (const call of mockedFetchManifest.mock.calls) expect(JSON.stringify(call)).not.toContain('csv-parse');
    for (const call of mockedFetchModule.mock.calls) expect(JSON.stringify(call)).not.toContain('csv-parse');
    expect(esmUrls.filter((u) => u.includes('csv-parse'))).toEqual([]);
  });

  it('no deferred-failure warning: an excluded package is not a failure', () => {
    expect(
      warn.mock.calls
        .map((c) => c.join(' '))
        .filter((m) => m.includes('"csv-parse') && m.includes('could not be loaded')),
    ).toEqual([]);
  });
});
