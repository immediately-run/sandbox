/**
 * R3-1383 [harness] — a declared dependency that fails to load fails the IMPORT, not the boot.
 *
 * The live case: dibber declares `csv-parse` for its CLI. The primary CDN dropped
 * `csv-parse@^7.0.3`, and its esm.sh build spans an internal chunk, which the single-module
 * fallback refuses. The README page never imports it, yet the whole boot failed. Driven
 * through the real registry, the real esm.sh chunk check and the real resolver, with only the
 * CDN and the esm.sh fetch replaced.
 */
import { underAppRoot } from '../../fsLayout';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';
import { fetchManifest, fetchModule } from '../module-registry/module-cdn';
import { deferredFailureModulePath } from '../module-registry/deferredFailures';

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
    main: 'src/index.ts',
    dependencies: { 'csv-parse': '^7.0.3' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': 'export default 1;\n',
  'src/importsRoot.ts': "import { parse } from 'csv-parse';\nexport default parse;\n",
  'src/importsSubpath.ts': "import { parse } from 'csv-parse/sync';\nexport default parse;\n",
};

// What esm.sh answers for csv-parse today: an entry that re-exports an internal chunk.
const MULTI_CHUNK_ENTRY = 'export * from "/csv-parse@7.0.3/X-ZUBpbW1lZGlhdGVseS1ydW4vc2Rr/es2022/csv-parse.mjs";\n';

/** Evaluate a compiled CommonJS module, returning what it threw. */
const thrownBy = (source: string): Error | undefined => {
  try {
    new Function('module', 'exports', 'require', source)({ exports: {} }, {}, () => ({}));
  } catch (err) {
    return err as Error;
  }
  return undefined;
};

let h: BundlerHarness;
let warn: jest.SpyInstance;

// One harness for the file: the harness mounts ZenFS at global points, so a second one in the
// same file collides (the suite's convention, see bundlerHarness.esmFallbackSubpath.test.ts).
// Each test re-boots the registry, which is the path a package.json edit takes.
beforeAll(async () => {
  h = await createBundlerHarness(FIXTURE, { forCompile: false });
  await h.bundler.initPreset('create-react-app');
});

afterAll(async () => {
  await h.teardown();
});

beforeEach(() => {
  mockedFetchManifest.mockReset();
  mockedFetchModule.mockReset();
  mockedFetchManifest.mockResolvedValue([]); // the primary CDN drops csv-parse
  mockedFetchModule.mockResolvedValue({ f: {}, m: [] });
  h.bundler.moduleRegistry.setEsmFallbackFetcher(async () => MULTI_CHUNK_ENTRY);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

const boot = async (deps: Record<string, string> = { 'csv-parse': '^7.0.3' }) => {
  // The caches `compile()` resets before every boot (bundler.ts, "Reset resolver cache").
  const b = h.bundler as unknown as {
    resolverCache: Map<string, unknown>;
    resolutionCache: Map<string, unknown>;
    cdnLayoutEligibility: Map<string, unknown>;
    fs: { resetCache(): void };
  };
  b.resolverCache = new Map();
  b.resolutionCache = new Map();
  b.cdnLayoutEligibility = new Map();
  b.fs.resetCache();
  await h.bundler.moduleRegistry.fetchManifest(deps);
  await h.bundler.moduleRegistry.preloadModules();
  await h.bundler.moduleRegistry.loadModuleDependencies();
};

const stubPath = deferredFailureModulePath('csv-parse');

describe('R3-1383 — a failed declared dependency is deferred to its import', () => {
  it('boots when nothing imports the package, warning once with the real esm.sh reason', async () => {
    await expect(boot()).resolves.toBeUndefined();
    const entry = await h.bundler.transformModule(underAppRoot('/src/index.ts'));
    expect(entry.compilationError ?? null).toBeNull();
    expect(h.bundler.moduleRegistry.deferredFailurePath('csv-parse')).toBe(stubPath);
    const warnings = warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('could not be loaded'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"csv-parse@^7.0.3"');
    expect(warnings[0]).toContain('internal chunk');
  }, 60000);

  it.each([
    ['the package root', '/src/importsRoot.ts', 'csv-parse'],
    ['a subpath (dibber imports csv-parse/sync)', '/src/importsSubpath.ts', 'csv-parse/sync'],
  ])(
    'importing %s resolves to the stub, which throws the recorded error',
    async (_label, file, specifier) => {
      await boot();
      const importer = await h.bundler.transformModule(underAppRoot(file));
      expect(importer.dependencyMap.get(specifier)).toBe(stubPath);
      const stub = await h.bundler.transformModule(stubPath);
      const err = thrownBy(stub.compiled ?? stub.source);
      expect(err?.message).toMatch(
        /^Could not resolve "csv-parse@\^7\.0\.3" from the package CDN, and the esm\.sh fallback/,
      );
      expect(err?.message).toContain('internal chunk');
    },
    60000,
  );

  // A deferral lasts as long as the registry (the frame), and the harness is shared, so each
  // remaining case uses its own package name.
  it("defers a package the CDN dropped with the fallback off, with the shared guard's wording", async () => {
    h.bundler.moduleRegistry.setEsmFallbackFetcher(null);
    await expect(boot({ 'other-cli-dep': '^1.0.0' })).resolves.toBeUndefined();
    const stub = await h.bundler.transformModule(deferredFailureModulePath('other-cli-dep'));
    expect(thrownBy(stub.compiled ?? stub.source)?.message).toMatch(
      /^Could not resolve package from the package CDN: "other-cli-dep@\^1\.0\.0"/,
    );
  }, 60000);

  it('still fails the boot for a TRANSITIVE package that fails to load', async () => {
    mockedFetchManifest.mockResolvedValue([
      { n: 'cli-root', v: '1.0.0', d: 0 },
      { n: 'some-transitive', v: '1.0.0', d: 1 },
    ]);
    mockedFetchModule.mockImplementation(async (name) => {
      if (name === 'some-transitive') throw new Error('transitive fetch failed');
      return { f: { 'package.json': { c: '{"main":"index.js"}', d: [], t: true } }, m: [] };
    });
    await expect(boot({ 'cli-root': '^1.0.0' })).rejects.toThrow('transitive fetch failed');
    expect(h.bundler.moduleRegistry.deferredFailure('some-transitive')).toBeUndefined();
  }, 60000);

  it('a re-boot in the same frame keeps the deferral: the same stub, no second warning', async () => {
    await boot();
    expect(h.bundler.moduleRegistry.deferredFailurePath('csv-parse')).toBe(stubPath);
    warn.mockClear();
    // The CDN now serves the package. A dependency change reloads the frame (bundler.ts,
    // "Dependencies changed, reloading"), and the reload is the retry; an in-place re-boot
    // keeps what the registry holds, as it does for a package that loaded.
    mockedFetchManifest.mockResolvedValue([{ n: 'csv-parse', v: '7.0.3', d: 0 }]);
    mockedFetchModule.mockResolvedValue({
      f: {
        'package.json': { c: '{"name":"csv-parse","version":"7.0.3","main":"lib/main.js"}', d: [], t: true },
        'lib/main.js': { c: 'exports.parse = function parse() { return []; };\n', d: [], t: true },
      },
      m: [],
    });
    await boot();
    expect(h.bundler.moduleRegistry.deferredFailurePath('csv-parse')).toBe(stubPath);
    expect(warn.mock.calls.map((c) => c.join(' ')).filter((m) => m.includes('could not be loaded'))).toEqual([]);
    const importer = await h.bundler.transformModule(underAppRoot('/src/importsSubpath.ts'));
    expect(importer.dependencyMap.get('csv-parse/sync')).toBe(stubPath);
  }, 60000);
});
