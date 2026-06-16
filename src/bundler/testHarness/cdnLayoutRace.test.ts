import { NodeModule } from '../module-registry/NodeModule';
import { createBundlerHarness, COMPILE_FIXTURE, type BundlerHarness } from './bundlerHarness';

// R3-49d repro: the CDN-layout fast path resolves relative node_modules imports
// synchronously, which changes concurrency. This test floods the bundler with
// concurrent resolutions — relative imports inside an eligible package (fast path)
// interleaved with BARE subpath imports of the same package (which fall through to
// the gensync resolver over CachedFS) — and asserts NONE spuriously fail. A spurious
// ModuleNotFound for a file that exists in the registry reproduces the live regression
// (example-blog/file-explorer: "Cannot find module core-js/modules/esnext.iterator.find.js").
describe('R3-49d CDN-layout fast path — concurrent resolution does not spuriously fail', () => {
  let h: BundlerHarness;

  // Build an eligible package (only a plain main field → pkgRoot-only alias) with many
  // files: internal modules that import each other relatively + leaf "modules/*" files
  // reachable as bare subpaths.
  const FILE_COUNT = 80;
  function seedPackage(): void {
    const files: Record<string, { c: string; d: string[]; t: boolean }> = {
      'package.json': { c: '{"name":"corish","version":"1.0.0","main":"index.js"}', d: [], t: false },
      'index.js': { c: 'module.exports = {};', d: [], t: false },
    };
    for (let i = 0; i < FILE_COUNT; i++) {
      // internals/iN.js imports a sibling internal relatively (fast-path territory)
      files[`internals/i${i}.js`] = { c: `require('./i${(i + 1) % FILE_COUNT}'); module.exports = ${i};`, d: [`./i${(i + 1) % FILE_COUNT}`], t: false };
      // modules/mN.js are leaf files reachable as bare subpaths
      files[`modules/m${i}.js`] = { c: `module.exports = ${i};`, d: [], t: false };
    }
    h.bundler.moduleRegistry.modules.set('corish', new NodeModule('corish', '1.0.0', files, []));
  }

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
    seedPackage();
  });
  afterEach(() => h.teardown());

  it('resolves a bare subpath reliably amid a flood of concurrent fast-path resolutions', async () => {
    const failures: string[] = [];
    // Run many trials; the race is schedule-dependent, so repeat to expose it.
    for (let trial = 0; trial < 20; trial++) {
      h.bundler.resetModules();
      const tasks: Array<Promise<unknown>> = [];
      // Flood: relative resolutions inside the package (fast path) ...
      for (let i = 0; i < FILE_COUNT; i++) {
        tasks.push(h.bundler.resolveAsync(`./i${(i + 1) % FILE_COUNT}`, `/node_modules/corish/internals/i${i}.js`));
      }
      // ... interleaved with BARE subpath resolutions through the real resolver.
      for (let i = 0; i < FILE_COUNT; i++) {
        const spec = `corish/modules/m${i}.js`;
        tasks.push(
          h.bundler.resolveAsync(spec, '/app/src/index.ts').then(
            (r) => { if (r !== `/node_modules/corish/modules/m${i}.js`) failures.push(`wrong:${spec}=>${r}`); },
            (e) => { failures.push(`threw:${spec}:${(e as Error).message}`); },
          ),
        );
      }
      await Promise.all(tasks);
    }
    expect(failures).toEqual([]);
  });
});
