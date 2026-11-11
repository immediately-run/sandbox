import { BundlerError } from '../errors/BundlerError';
import { createBundlerHarness, type BundlerHarness } from './testHarness/bundlerHarness';

// The §4.1 entry classification's tests live in entryPoint.test.ts; this sibling
// pins the arm that suite does not reach: the candidate loop's terminal throw when
// NOTHING resolves (no main/source/module, no preset default on the mount), which
// the classification restructure had to preserve verbatim.
describe('resolveEntryPoint — the no-candidate arm', () => {
  let h: BundlerHarness;

  afterEach(() => h.teardown());

  it('throws the diagnostic naming the candidates when nothing resolves', async () => {
    h = await createBundlerHarness({ 'package.json': JSON.stringify({ name: 'empty' }) }, { forCompile: true });
    await h.bundler.processPackageJSON();
    await expect(h.bundler.resolveEntryPoint()).rejects.toBeInstanceOf(BundlerError);
    await expect(h.bundler.resolveEntryPoint()).rejects.toThrow(/Could not resolve entry point/);
    await expect(h.bundler.resolveEntryPoint()).rejects.toThrow(/"main" field/);
  });
});
