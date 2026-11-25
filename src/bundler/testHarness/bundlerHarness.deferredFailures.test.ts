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
  // A fresh resolution per boot, as after a package.json edit's recompile.
  (h.bundler as unknown as { resolutionCache: Map<string, unknown> }).resolutionCache.clear();
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

  it("defers a package the CDN dropped with the fallback off, with the shared guard's wording", async () => {
    h.bundler.moduleRegistry.setEsmFallbackFetcher(null);
    await expect(boot()).resolves.toBeUndefined();
    const stub = await h.bundler.transformModule(stubPath);
    expect(thrownBy(stub.compiled ?? stub.source)?.message).toMatch(
      /^Could not resolve package from the package CDN: "csv-parse@\^7\.0\.3"/,
    );
  }, 60000);

  it('still fails the boot for a TRANSITIVE package that fails to load', async () => {
    mockedFetchManifest.mockResolvedValue([
      { n: 'csv-parse', v: '7.0.3', d: 0 },
      { n: 'some-transitive', v: '1.0.0', d: 1 },
    ]);
    mockedFetchModule.mockImplementation(async (name) => {
      if (name === 'some-transitive') throw new Error('transitive fetch failed');
      return { f: { 'package.json': { c: '{"main":"index.js"}', d: [], t: true } }, m: [] };
    });
    await expect(boot()).rejects.toThrow('transitive fetch failed');
  }, 60000);

  it('a re-boot retries a deferred package and serves the real one once it loads', async () => {
    // An earlier test loaded a real csv-parse; the registry keeps loaded packages across boots.
    h.bundler.moduleRegistry.modules.delete('csv-parse');
    await boot();
    expect(h.bundler.moduleRegistry.deferredFailurePath('csv-parse')).toBe(stubPath);
    mockedFetchManifest.mockResolvedValue([{ n: 'csv-parse', v: '7.0.3', d: 0 }]);
    mockedFetchModule.mockResolvedValue({
      f: {
        'package.json': { c: '{"name":"csv-parse","main":"index.js"}', d: [], t: true },
        'index.js': { c: 'exports.parse = function parse() { return []; };\n', d: [], t: true },
      },
      m: [],
    });
    await boot();
    expect(h.bundler.moduleRegistry.deferredFailurePath('csv-parse')).toBeNull();
    const real = await h.bundler.transformModule(stubPath);
    expect(real.compiled ?? real.source).toContain('exports.parse');
  }, 60000);
});
