import { ARTIFACTS_DIR } from '@immediately-run/platform-constants';

import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';

// G-MDX-3b: seed the MDX-frontmatter store from the cache-zip sidecar
// (MDX_CONTENT_COLLECTIONS_SPEC §1.3/§1.4) instead of walking the tree, with
// blob-SHA confinement, `/app`-key translation, live fallback for modified files,
// and the `getMetadataSnapshot()` identity contract. No MDX compile here (jest can't
// run the ESM-only `@mdx-js/mdx` dynamic import) — seeding reads JSON + parses
// frontmatter (`yaml`, no dynamic import), so this whole path is jest-testable.

const MDX_METADATA_REPO_PATH = `/${ARTIFACTS_DIR}/mdx-metadata.json`;

const lastMetadataOf = (h: BundlerHarness): Map<string, Record<string, unknown>> =>
  (h.bundler as unknown as { lastMetadata: Map<string, Record<string, unknown>> }).lastMetadata;
const setDirty = (h: BundlerHarness, paths: string[]): void => {
  (h.bundler as unknown as { dirtyPaths: Set<string> }).dirtyPaths = new Set(paths);
};

const manifest = (entries: Array<{ path: string; sha: string }>) =>
  JSON.stringify({ schemaVersion: 1, entries: entries.map((e) => ({ ...e, type: 'blob' })) });

describe('G-MDX-3b — sidecar seeding of the MDX metadata store', () => {
  let h: BundlerHarness;
  afterEach(async () => {
    if (h) await h.teardown();
  });

  it('seeds /app-keyed frontmatter from JSON with confinement + live fallback for dirty', async () => {
    h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export default 1;\n',
      '.immediately.run/contribute-manifest.json': manifest([
        { path: 'content/post.mdx', sha: 'sha-post' },
        { path: 'content/dirty.mdx', sha: 'sha-dirty' },
        { path: 'content/drift.mdx', sha: 'sha-drift' },
      ]),
      '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
        schemaVersion: 1,
        files: {
          '/content/post.mdx': { srcSha: 'sha-post', frontmatter: { title: 'Hello', tags: ['a'] } },
          '/content/dirty.mdx': { srcSha: 'sha-dirty', frontmatter: { title: 'Stale' } },
          '/content/drift.mdx': { srcSha: 'DIFFERENT', frontmatter: { title: 'Drift' } }, // srcSha≠manifest
          '/content/ghost.mdx': { srcSha: 'x', frontmatter: { title: 'Ghost' } }, // not in manifest
        },
      }),
      // The dirty file exists on disk with EDITED frontmatter (the live fallback reads it).
      // NOTE: content/post.mdx is deliberately ABSENT on disk — it is seeded from JSON
      // alone, proving no source read/walk on the clean cached path.
      'content/dirty.mdx': '---\ntitle: Edited\n---\n\n# edited\n',
    });
    setDirty(h, ['/content/dirty.mdx']);

    await h.bundler.preloadMDXMetadata();
    const meta = lastMetadataOf(h);

    // Clean covered file: seeded from JSON, /app-translated (metadataKey.test contract).
    expect(meta.get('/app/content/post.mdx')).toEqual({ title: 'Hello', tags: ['a'] });
    // Dirty file: LIVE-read edited value wins over the stale sidecar entry.
    expect(meta.get('/app/content/dirty.mdx')).toEqual({ title: 'Edited' });
    // Confinement drops: srcSha drift + non-manifest entry never seed.
    expect(meta.has('/app/content/drift.mdx')).toBe(false);
    expect(meta.has('/app/content/ghost.mdx')).toBe(false);
    // Repo-relative keys never leak into the store.
    expect(meta.has('/content/post.mdx')).toBe(false);
  });

  it('getMetadataSnapshot() returns the SAME value refs the store holds (identity contract)', async () => {
    h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export default 1;\n',
      '.immediately.run/contribute-manifest.json': manifest([{ path: 'content/post.mdx', sha: 'sha-post' }]),
      '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
        schemaVersion: 1,
        files: { '/content/post.mdx': { srcSha: 'sha-post', frontmatter: { title: 'Hello' } } },
      }),
    });
    await h.bundler.preloadMDXMetadata();

    const snap = h.bundler.getMetadataSnapshot();
    // Same object identity as the store value (NOT a clone) — this is what makes the
    // SDK's DelayedEmitter replay a zero-re-render no-op (§1.4).
    expect(snap['/app/content/post.mdx']).toBe(lastMetadataOf(h).get('/app/content/post.mdx'));
    expect(snap['/app/content/post.mdx']).toEqual({ title: 'Hello' });
  });

  it('a writable-layer sidecar is rejected eagerly + emits artifact-distrust, then live-scans', async () => {
    h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export default 1;\n',
      '.immediately.run/contribute-manifest.json': manifest([{ path: 'content/post.mdx', sha: 'sha-post' }]),
      '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
        schemaVersion: 1,
        files: { '/content/post.mdx': { srcSha: 'sha-post', frontmatter: { title: 'Forged' } } },
      }),
      // The real source on disk carries the honest frontmatter (the live walk reads it).
      'content/post.mdx': '---\ntitle: Real\n---\n\n# real\n',
    });
    // Mark the sidecar itself as writable-layer (COW) → §3 eager rejection.
    setDirty(h, [MDX_METADATA_REPO_PATH]);

    await h.bundler.preloadMDXMetadata();

    const distrust = h.sentMessages.find((m) => m.type === 'artifact-distrust');
    expect(distrust?.data).toMatchObject({ reason: 'writable-layer-mdx-metadata' });
    // Fell through to the live walk → the HONEST value, not the forged sidecar one.
    expect(lastMetadataOf(h).get('/app/content/post.mdx')).toEqual({ title: 'Real' });
  });

  it('no sidecar → the live walk still populates the store (fallback unchanged)', async () => {
    h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export default 1;\n',
      'content/post.mdx': '---\ntitle: Live\n---\n\n# live\n',
    });
    await h.bundler.preloadMDXMetadata();
    expect(lastMetadataOf(h).get('/app/content/post.mdx')).toMatchObject({ title: 'Live' });
  });
});
