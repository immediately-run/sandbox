import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// The per-compile resolution-RESULT cache (bundler.resolveAsync): node resolution is
// dir-relative, so the same (specifier, dir) resolves identically — memoize it so the
// algorithm doesn't re-run for every edge across the node_modules closure (the
// cold-boot cost). Reset per compile so edits get fresh resolution.
describe('resolveAsync resolution-result cache', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness({
      'a.ts': "import './shared';\nexport const a = 1;\n",
      'b.ts': "import './shared';\nexport const b = 2;\n",
      'shared.ts': 'export const s = 0;\n',
    });
  });
  afterEach(() => h.teardown());

  it('resolves correctly and memoizes by (specifier, dir)', async () => {
    const r1 = await h.bundler.resolveAsync('./shared', '/app/a.ts');
    expect(r1).toBe('/app/shared.ts');
    expect(h.bundler.resolutionCache.size).toBe(1);

    // Same specifier from a DIFFERENT file in the SAME dir → same result, still 1 entry
    // (the key is the dir, not the file): the second call is served from cache.
    const r2 = await h.bundler.resolveAsync('./shared', '/app/b.ts');
    expect(r2).toBe('/app/shared.ts');
    expect(h.bundler.resolutionCache.size).toBe(1);

    // A repeat of the exact call is also a hit (no growth).
    await h.bundler.resolveAsync('./shared', '/app/a.ts');
    expect(h.bundler.resolutionCache.size).toBe(1);
  });

  it('does not cache a failed resolution (so a later add can resolve)', async () => {
    await expect(h.bundler.resolveAsync('./does-not-exist', '/app/a.ts')).rejects.toBeDefined();
    expect(h.bundler.resolutionCache.size).toBe(0);
  });

  it('clears the cache on reset (fresh resolution per build)', async () => {
    await h.bundler.resolveAsync('./shared', '/app/a.ts');
    expect(h.bundler.resolutionCache.size).toBe(1);
    // resetModules() + the top of compile() both clear it alongside resolverCache,
    // so an edit re-resolves against the new FS state.
    h.bundler.resetModules();
    expect(h.bundler.resolutionCache.size).toBe(0);
  });
});
