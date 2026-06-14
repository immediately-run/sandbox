import { underAppRoot } from '../../fsLayout';

import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// R3-48 G0-0 compile smoke: boot the REAL Bundler in-process and drive its transpile
// pipeline (`transformModule`) over the harness fs — it reads the entry + its local
// import from `/app` through the recorded stand-in (the Port-traffic spy) and
// transpiles each via the in-process babel loopback. This is the "boots the fixture,
// transpiles the entrypoint" half of G0-0's exit; the full `compile()` assembly
// (platform SDK vendoring + react-refresh runtime + CDN dep-tree) needs the whole
// module environment and is out of scope for an FS-routing/transpile smoke.
describe('G0-0 bundler transpile smoke (booted bundler + babel loopback over the harness fs)', () => {
  let h: BundlerHarness;
  let entry: Awaited<ReturnType<BundlerHarness['bundler']['transformModule']>>;
  let dep: typeof entry;

  beforeAll(async () => {
    h = await createBundlerHarness();
    await h.bundler.initPreset('create-react-app'); // the registered preset key
    h.resetSpies();
    entry = await h.bundler.transformModule(underAppRoot('/src/index.ts'));
    dep = await h.bundler.transformModule(underAppRoot('/src/answer.ts'));
  }, 60000);

  afterAll(async () => {
    await h.teardown();
  });

  it('transpiles the entry module via the babel loopback', () => {
    expect(typeof entry.compiled).toBe('string');
    expect(entry.compiled).toContain('answer'); // the import survived as a reference
  });

  it("strips the dependency's TypeScript types", () => {
    expect(typeof dep.compiled).toBe('string');
    expect(dep.compiled).not.toContain(': number'); // `const answer: number` → stripped
  });

  it('resolves the local import to its /app path as a dependency of the entry', () => {
    expect([...entry.dependencies].some((d) => d.endsWith('/src/answer.ts'))).toBe(true);
  });

  it('read the entry + its local import from /app over the Port-traffic spy', () => {
    const appReads = h.portOps.map((op) => op.path);
    expect(appReads.some((p) => p.endsWith('index.ts'))).toBe(true);
    expect(appReads.some((p) => p.endsWith('answer.ts'))).toBe(true);
  });
});
