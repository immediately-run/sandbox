import { createBundlerHarness, type BundlerHarness } from './testHarness/bundlerHarness';

// G2-4 [harness] sandbox side: the §5.2 dirty set the host pushes on
// register-frame reaches the Bundler, where the seeding path consults it
// (PRETRANSPILED_ARTIFACTS_SPEC §5.2; the seeding consult itself lands in G2-5).
describe('Bundler dirty set', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness();
  });

  afterEach(() => h.teardown());

  it('marks injected paths dirty and leaves others clean', () => {
    h.bundler.setDirtyPaths(['/src/App.tsx', '/src/old.ts']);
    expect(h.bundler.isDirtyPath('/src/App.tsx')).toBe(true);
    expect(h.bundler.isDirtyPath('/src/old.ts')).toBe(true);
    expect(h.bundler.isDirtyPath('/src/clean.tsx')).toBe(false);
  });

  it('treats an undefined/empty dirty set as nothing dirty', () => {
    h.bundler.setDirtyPaths(['/src/App.tsx']);
    h.bundler.setDirtyPaths(undefined);
    expect(h.bundler.isDirtyPath('/src/App.tsx')).toBe(false);
  });
});
