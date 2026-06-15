import { fs } from '@zenfs/core';

import { createBundlerFsHarness, FIXTURE_APP, type BundlerFsHarness } from './harness';

// R3-48 G0-0 smoke: prove the `/app` Port-traffic spy is wired and observable — a read
// crosses the Port (Port spy) and nothing under `/node_modules` ever does. As of G0-4
// the Bundler owns the `/node_modules` mount (it needs the bundler's ModuleRegistry),
// so the `/node_modules` zero-Port-traffic + lazy-fetch assertions live in the
// bundler-driven `bundlerHarness.nodeModules.test.ts`. No production behavior here.
describe('G0-0 bundler FS harness (InMemory /app stand-in + Port spy)', () => {
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
});
