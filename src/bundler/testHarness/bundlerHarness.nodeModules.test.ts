import { fs } from '@zenfs/core';

import { NodeModule } from '../module-registry/NodeModule';
import { createBundlerHarness, COMPILE_FIXTURE, type BundlerHarness } from './bundlerHarness';

// R3-48 G0-4 [harness] proofs for the bundler-owned `/node_modules` + `/transpiled`
// mounts (plan 02-zenfs-unification.md exit map). The bundler reads `/node_modules`
// through its `CachedFS` → the `CopyOnWrite` over `RegistryFS` mount (over the bundler's
// own `ModuleRegistry`); the network spy is injected via `setRegistryFetcher`. Each
// assertion below is one of the acceptance rows that MUST be proven by a harness test
// (not manual observation):
//   - zero Port traffic for `/node_modules` & `/transpiled` reads
//   - lazy unpkg fetch observable for a listed-but-not-inlined file
//   - warm boot (inlined file) issues zero CDN/unpkg fetches
describe('G0-4 [harness] /node_modules + /transpiled mount routing', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
    // Seed the bundler's OWN ModuleRegistry — the `/node_modules` CoW reads through it.
    // One inlined file (served from the registry, no network) and one listed-but-NOT
    // inlined file (a numeric entry → a lazy fetch through the injected network spy).
    h.bundler.moduleRegistry.modules.set(
      'leftpad',
      new NodeModule(
        'leftpad',
        '1.0.0',
        {
          'package.json': { c: '{"name":"leftpad","version":"1.0.0"}', d: [], t: false },
          'index.js': { c: 'module.exports = function pad(){};', d: [], t: false },
          'big.js': 12345, // listed-but-not-inlined → lazy fetch
        },
        [],
      ),
    );
    h.resetSpies();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('serves an inlined /node_modules file from the registry — no fetch, zero Port traffic', async () => {
    const content = await fs.promises.readFile('/node_modules/leftpad/index.js', 'utf8');

    expect(content).toBe('module.exports = function pad(){};');
    expect(h.fetchOps).toEqual([]); // inlined → no network (warm-boot: zero CDN/unpkg)
    expect(h.portOps).toEqual([]); // the read NEVER crossed the /app Port
  });

  it('lazily fetches a listed-but-not-inlined file via the network spy — once, off the Port', async () => {
    const content = await fs.promises.readFile('/node_modules/leftpad/big.js', 'utf8');

    expect(content).toContain('fetched leftpad@1.0.0/big.js');
    // exactly one fetch, with the right (module, version, relPath) — the lazy-fetch row
    expect(h.fetchOps).toEqual([{ module: 'leftpad', version: '1.0.0', relPath: 'big.js' }]);
    expect(h.portOps).toEqual([]); // and it did NOT cross the /app Port
  });

  it('serves a /transpiled tmpfs round-trip off the mount — zero Port traffic', async () => {
    // /transpiled is an InMemory tmpfs mount the bundler owns; writing + reading it must
    // never touch the parent-hosted /app Port.
    await fs.promises.writeFile('/transpiled/out.js', 'compiled output');
    const content = await fs.promises.readFile('/transpiled/out.js', 'utf8');

    expect(content).toBe('compiled output');
    expect(h.portOps).toEqual([]);
  });

  it('a /node_modules read does not appear on the /app Port even alongside an /app read', async () => {
    // Sanity: an /app read DOES cross the Port, proving the spy is live — so the empty
    // result above is a real "zero Port traffic", not a dead spy.
    await fs.promises.readFile('/app/package.json', 'utf8');
    await fs.promises.readFile('/node_modules/leftpad/index.js', 'utf8');

    expect(h.portOps.some((op) => op.path.endsWith('package.json'))).toBe(true);
    expect(h.portOps.every((op) => !op.path.includes('node_modules'))).toBe(true);
  });
});
