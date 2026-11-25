/**
 * R3-1383 [harness] — the full boot: `compile()` runs `Bundler.loadNodeModules` (SDK peers,
 * preset augmentation, the lockset path) and the compiled graph EVALUATES. A page that never
 * imports a failed declared package runs; the import fails through the normal module path with
 * the recorded message. Only the CDN and the esm.sh fetch are replaced. Its own file because
 * a harness mounts ZenFS at global points (one per file).
 */
import { createBundlerHarness, installEvalGlobals, type BundlerHarness } from './bundlerHarness';
import { fetchManifest, fetchModule } from '../module-registry/module-cdn';

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
    dependencies: { 'csv-parse': '^7.0.3' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  // The page runs without csv-parse; the CLI path is reached only when called.
  'src/main.ts':
    'const g = globalThis as Record<string, unknown>;\n' +
    'g.__deferredBooted = true;\n' +
    "g.__loadCsv = () => import('csv-parse/sync');\n" +
    'export default 1;\n',
};

const MULTI_CHUNK_ENTRY = 'export * from "/csv-parse@7.0.3/X-ZUBpbW1lZGlhdGVseS1ydW4vc2Rr/es2022/csv-parse.mjs";\n';

const g = globalThis as Record<string, unknown>;
let h: BundlerHarness;
let restore: () => void;
let warn: jest.SpyInstance;

beforeAll(async () => {
  restore = installEvalGlobals();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockedFetchManifest.mockResolvedValue([]); // the primary CDN drops csv-parse
  mockedFetchModule.mockResolvedValue({ f: {}, m: [] });
  h = await createBundlerHarness(FIXTURE, { forCompile: true });
  // Only csv-parse spans an internal chunk; the preset's own additions load as one module.
  h.bundler.moduleRegistry.setEsmFallbackFetcher(async (url) =>
    url.includes('/csv-parse@') ? MULTI_CHUNK_ENTRY : 'export default {};\n',
  );
  const evaluate = await h.bundler.compile();
  (evaluate as () => unknown)();
}, 120000);

afterAll(async () => {
  delete g.__deferredBooted;
  delete g.__loadCsv;
  warn.mockRestore();
  await h.teardown();
  restore();
});

describe('R3-1383 — compile() and evaluate with a failed declared dependency', () => {
  it('the page evaluates although csv-parse failed to load, with one warning naming it', () => {
    expect(g.__deferredBooted).toBe(true);
    const warnings = warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('"csv-parse@^7.0.3" could not'));
    expect(warnings).toHaveLength(1);
    expect(warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('could not be loaded'))).toHaveLength(1);
  });

  it('importing it fails at evaluation with the recorded esm.sh error', async () => {
    const load = g.__loadCsv as () => Promise<unknown>;
    await expect(load()).rejects.toThrow(
      /^Could not resolve "csv-parse@\^7\.0\.3" from the package CDN, and the esm\.sh fallback .*internal chunk/s,
    );
  });
});
