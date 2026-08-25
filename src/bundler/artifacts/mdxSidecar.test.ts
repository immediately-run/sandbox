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

  // R3-275 — the sidecar's SHAPE is validated by the shared
  // `@immediately-run/platform-constants` validator now, the same one the CLI's
  // emitter is written against. R3-275c then fixed what those verdicts DO: a file this
  // reader cannot interpret costs the repo its cached metadata but NOT its metadata,
  // and one malformed entry costs only itself — visibly.
  //
  // The control is `no sidecar → the live walk still populates the store` above: each
  // case below asserts the SAME observable outcome as having no sidecar at all, which
  // is the whole claim ("a cache that is damaged gives you the slow answer, not the
  // wrong one"). Asserting merely that the forged value is absent would pass on the
  // broken behaviour too — the store was empty then.
  describe.each([
    [
      'an unknown schemaVersion',
      'schema-version',
      // This reader does not know what it is looking at, so honouring the parts it
      // recognises is exactly the misreading the version check exists to prevent.
      JSON.stringify({
        schemaVersion: 2,
        files: { '/content/post.mdx': { srcSha: 'sha-post', frontmatter: { title: 'FromSidecar' } } },
      }),
    ],
    ['unparseable JSON', 'not-an-object', '{"schemaVersion": 1, "files": {'],
    ['a non-object `files`', 'files-not-an-object', JSON.stringify({ schemaVersion: 1, files: 'nope' })],
  ])('an unusable sidecar (%s) falls back to the live walk — R3-275c', (_label, verdict, sidecar) => {
    it('live-scans, and says once which verdict fired', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        h = await createBundlerHarness({
          'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
          'index.html': '<!doctype html><div id="root"></div>',
          'src/index.ts': 'export default 1;\n',
          '.immediately.run/contribute-manifest.json': manifest([{ path: 'content/post.mdx', sha: 'sha-post' }]),
          '.immediately.run/artifacts/mdx-metadata.json': sidecar,
          'content/post.mdx': '---\ntitle: FromDisk\n---\n\n# hi\n',
        });

        await h.bundler.preloadMDXMetadata();
        const meta = lastMetadataOf(h);

        // The live walk ran: the store holds what the SOURCE says, exactly as it would
        // with no sidecar present at all.
        expect(meta.get('/app/content/post.mdx')).toMatchObject({ title: 'FromDisk' });

        // …and the reason is on the record, named, once — not a silent empty store.
        const said = warn.mock.calls
          .map((c) => c.join(' '))
          .filter((line) => line.includes('MDX metadata sidecar unusable'));
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(verdict);
      } finally {
        warn.mockRestore();
      }
    });

    it('does NOT emit artifact-distrust — a malformed sidecar is a defect, not tampering', async () => {
      h = await createBundlerHarness({
        'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
        'index.html': '<!doctype html><div id="root"></div>',
        'src/index.ts': 'export default 1;\n',
        '.immediately.run/contribute-manifest.json': manifest([{ path: 'content/post.mdx', sha: 'sha-post' }]),
        '.immediately.run/artifacts/mdx-metadata.json': sidecar,
        'content/post.mdx': '---\ntitle: FromDisk\n---\n\n# hi\n',
      });

      await h.bundler.preloadMDXMetadata();

      // Distrust persists a mark for this (repo, commitSha) and takes the whole
      // pre-transpiled artifact section down with it. Reserved for the writable-layer
      // case above, which IS a security event.
      expect(h.sentMessages.find((m) => m.type === 'artifact-distrust')).toBeUndefined();
    });
  });

  it('one malformed entry is dropped and COUNTED; the rest of the sidecar still seeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export default 1;\n',
      '.immediately.run/contribute-manifest.json': manifest([
        { path: 'content/good.mdx', sha: 'sha-good' },
        { path: 'content/bad.mdx', sha: 'sha-bad' },
        { path: 'content/empty.mdx', sha: 'sha-empty' },
      ]),
      '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
        schemaVersion: 1,
        files: {
          '/content/good.mdx': { srcSha: 'sha-good', frontmatter: { title: 'Good' } },
          '/content/bad.mdx': { srcSha: 'sha-bad', frontmatter: 'not an object' },
          '/content/empty.mdx': { srcSha: 'sha-empty', frontmatter: {} },
        },
      }),
    });

    await h.bundler.preloadMDXMetadata();
    const meta = lastMetadataOf(h);

    expect(meta.get('/app/content/good.mdx')).toEqual({ title: 'Good' });
    expect(meta.has('/app/content/bad.mdx')).toBe(false);
    expect(meta.has('/app/content/empty.mdx')).toBe(false);

    // R3-275c: the drop is right, the SILENCE was not — an author whose entry the
    // emitter malformed had no way to find out. Both rejected rows are named.
    const said = warn.mock.calls
      .map((c) => c.join(' '))
      .filter((line) => line.includes('MDX metadata sidecar: dropped'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('dropped 2 malformed entries');
    expect(said[0]).toContain('/content/bad.mdx: entry-frontmatter');
    expect(said[0]).toContain('/content/empty.mdx: entry-frontmatter-empty');
    warn.mockRestore();
  });
});
