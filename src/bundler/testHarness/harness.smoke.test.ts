import { fs } from '@zenfs/core';

import { createBundlerFsHarness, FIXTURE_APP, type BundlerFsHarness } from './harness';

// R3-48 G0-0 smoke: prove the harness's spies are wired and observable — an `/app`
// read crosses the Port (Port spy), a `/node_modules` lazy read goes to the network
// (fetch spy) and NOT over the Port. This is the foundation the `[harness]` tests in
// 02-zenfs-unification.md (zero-Port-traffic, warm-boot, lazy-fetch) build on; the
// full `bundler.compile()` smoke is the follow-on G0-0 piece (it adds a babel-worker
// loopback). No production behavior is exercised here.
describe('G0-0 bundler FS harness (InMemory /app stand-in + spies)', () => {
  let h: BundlerFsHarness;

  beforeEach(async () => {
    h = await createBundlerFsHarness();
  });
  afterEach(async () => {
    await h.teardown();
  });

  it('serves the seeded fixture at /app', async () => {
    const pkg = await fs.promises.readFile('/app/package.json', 'utf8');
    expect(pkg).toBe(FIXTURE_APP['package.json']);

    const app = await fs.promises.readFile('/app/src/App.tsx', 'utf8');
    expect(app).toBe(FIXTURE_APP['src/App.tsx']);
  });

  it('records /app reads on the Port spy (the read crossed the Port)', async () => {
    h.resetSpies();
    await fs.promises.readFile('/app/package.json', 'utf8');

    // The op reached the parent fs over the Port (path is mount-relative).
    expect(h.portOps.some((op) => op.path.endsWith('package.json'))).toBe(true);
    // And nothing in /node_modules ever crossed the /app Port.
    expect(h.portOps.every((op) => !op.path.includes('node_modules'))).toBe(true);
  });

  it('serves a lazy /node_modules file via the network spy — NOT over the Port', async () => {
    h.resetSpies();
    const content = await fs.promises.readFile('/node_modules/react/cjs/react.production.js', 'utf8');

    // The listed-but-not-inlined file was fetched (the network spy saw exactly one).
    expect(content).toContain('fetched react@18.3.1/cjs/react.production.js');
    expect(h.fetchOps).toEqual([{ module: 'react', version: '18.3.1', relPath: 'cjs/react.production.js' }]);
    // Crucially: the /node_modules read did NOT cross the /app Port (zero Port traffic).
    expect(h.portOps.every((op) => !op.path.includes('node_modules'))).toBe(true);
  });

  it('serves an inlined /node_modules file from the registry — no fetch, no Port', async () => {
    h.resetSpies();
    const content = await fs.promises.readFile('/node_modules/react/index.js', 'utf8');

    expect(content).toBe('module.exports = {};');
    expect(h.fetchOps).toEqual([]); // inlined → no network
    expect(h.portOps.every((op) => !op.path.includes('node_modules'))).toBe(true);
  });
});
