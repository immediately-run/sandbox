import { CONTRIBUTE_MANIFEST_PATH, MDX_METADATA_SIDECAR_PATH } from '@immediately-run/platform-constants';

import { createBundlerHarness, mountInMemoryFs, type BundlerHarness } from '../testHarness/bundlerHarness';

// R3-168 / MDX_FROM_MOUNT_SPEC §3 — the frontmatter sidecar of a SIBLING content mount
// seeds the metadata store, not just `/app`'s.
//
// The gap this closes is the spec's "path-keying caveat": the sidecar keys entries by
// absolute path and the seeding path went through `underAppRoot`, so a dispatched wiki
// mounted at `/mnt/{hash}` could ship a complete sidecar and still have every entry
// either dropped or written under a `/app/...` key that names nothing. Seeding now joins
// each repo-relative key to the ACTIVE root, exactly as `seedRoot` already did for
// pre-transpiled artifacts.
//
// The invariant the mount case rests on is containment, the same one `seedRoot` states
// per root: a mount's absent, damaged or unattested sidecar costs that mount its cached
// metadata and nothing else — never `/app`'s.

const MDX_METADATA_REPO_PATH = `/${MDX_METADATA_SIDECAR_PATH}`;
const MOUNT = '/mnt/wiki';

const manifest = (entries: Array<{ path: string; sha: string }>) =>
  JSON.stringify({ schemaVersion: 1, entries: entries.map((e) => ({ ...e, type: 'blob' })) });

const lastMetadataOf = (h: BundlerHarness): Map<string, Record<string, unknown>> =>
  (h.bundler as unknown as { lastMetadata: Map<string, Record<string, unknown>> }).lastMetadata;
const setDirty = (h: BundlerHarness, paths: string[]): void => {
  (h.bundler as unknown as { dirtyPaths: Set<string> }).dirtyPaths = new Set(paths);
};

/** An app repo with its own sidecar covering `content/app-post.mdx`. */
const APP_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': 'export default 1;\n',
  [CONTRIBUTE_MANIFEST_PATH]: manifest([{ path: 'content/app-post.mdx', sha: 'sha-app' }]),
  [MDX_METADATA_SIDECAR_PATH]: JSON.stringify({
    schemaVersion: 1,
    files: { '/content/app-post.mdx': { srcSha: 'sha-app', frontmatter: { title: 'From app' } } },
  }),
};

/** A content repo as its cache zip delivers it. `over` bends one input at a time. */
const contentRepo = (over: { sidecar?: string; srcSha?: string; manifest?: boolean } = {}): Record<string, string> => ({
  ...(over.manifest === false
    ? {}
    : { [CONTRIBUTE_MANIFEST_PATH]: manifest([{ path: 'entries/one.mdx', sha: 'sha-one' }]) }),
  [MDX_METADATA_SIDECAR_PATH]:
    over.sidecar ??
    JSON.stringify({
      schemaVersion: 1,
      files: {
        '/entries/one.mdx': { srcSha: over.srcSha ?? 'sha-one', frontmatter: { title: 'From mount', tags: ['w'] } },
      },
    }),
  'entries/one.mdx': '---\ntitle: On disk\n---\n\n# on disk\n',
});

describe("a content mount's frontmatter sidecar seeds the metadata store", () => {
  let h: BundlerHarness;
  let unmount: (() => void) | null = null;

  afterEach(async () => {
    unmount?.();
    unmount = null;
    if (h) await h.teardown();
  });

  /** Boot the app, mount a content fs at `/mnt/wiki`, and register it as an artifact root
   *  the way the dispatch path will. */
  const withContentMount = async (files: Record<string, string>, appFixture = APP_FIXTURE) => {
    h = await createBundlerHarness(appFixture);
    unmount = await mountInMemoryFs(MOUNT, files);
    h.bundler.artifactStore.addRoot(MOUNT);
  };

  it('seeds the mount-rooted key, alongside the app root, from JSON alone', async () => {
    await withContentMount(contentRepo());

    await h.bundler.preloadMDXMetadata();
    const meta = lastMetadataOf(h);

    // The mount entry is keyed under the MOUNT, not under `/app` and not repo-relative.
    expect(meta.get(`${MOUNT}/entries/one.mdx`)).toEqual({ title: 'From mount', tags: ['w'] });
    expect(meta.has('/app/entries/one.mdx')).toBe(false);
    expect(meta.has('/entries/one.mdx')).toBe(false);
    // Seeded from JSON, not read from disk: the sidecar's title wins over the source's.
    expect(meta.get(`${MOUNT}/entries/one.mdx`)).not.toMatchObject({ title: 'On disk' });
    // The app root still seeds exactly as before.
    expect(meta.get('/app/content/app-post.mdx')).toEqual({ title: 'From app' });
  });

  it("honours the MOUNT's own manifest — an entry it does not attest never seeds", async () => {
    // The binding check that makes seeding safe is per-root: the sidecar entry must name a
    // path in the SAME root's manifest and match its blob sha. This is what stops a mount
    // from asserting frontmatter for a file it does not ship.
    await withContentMount(contentRepo({ manifest: false }));

    await h.bundler.preloadMDXMetadata();

    expect(lastMetadataOf(h).has(`${MOUNT}/entries/one.mdx`)).toBe(false);
    // …and `/app` kept its own.
    expect(lastMetadataOf(h).get('/app/content/app-post.mdx')).toEqual({ title: 'From app' });
  });

  it('refuses a mount entry whose srcSha does not match the manifest — a swapped source', async () => {
    await withContentMount(contentRepo({ srcSha: 'sha-something-else' }));

    await h.bundler.preloadMDXMetadata();

    expect(lastMetadataOf(h).has(`${MOUNT}/entries/one.mdx`)).toBe(false);
  });

  it('an unusable mount sidecar is named and contained — it does not cost /app its cache', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withContentMount(contentRepo({ sidecar: '{"schemaVersion": 1, "files": {' }));

      await h.bundler.preloadMDXMetadata();

      // Contained: the app root's sidecar is still honoured.
      expect(lastMetadataOf(h).get('/app/content/app-post.mdx')).toEqual({ title: 'From app' });
      expect(lastMetadataOf(h).has(`${MOUNT}/entries/one.mdx`)).toBe(false);
      // Named: a silently-missing mount is indistinguishable from a mount with no content.
      const said = warn.mock.calls.map((c) => c.join(' ')).filter((line) => line.includes(MOUNT));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('not-an-object');
    } finally {
      warn.mockRestore();
    }
  });

  it("the app's COW dirty set never suppresses a mount entry that shares its repo-relative path", async () => {
    // `dirtyPaths` is the APP's copy-on-write bookkeeping, keyed repo-relative. Applying it
    // to a mount compares two different key spaces: a user editing their own
    // `entries/one.mdx` would silently blank the wiki's unrelated file of the same name.
    await withContentMount(contentRepo());
    setDirty(h, ['/entries/one.mdx']);

    await h.bundler.preloadMDXMetadata();

    expect(lastMetadataOf(h).get(`${MOUNT}/entries/one.mdx`)).toMatchObject({ title: 'From mount' });
  });

  it("a writable-layer marking of the app's sidecar does not reject the mount's", async () => {
    // The §3 readable-layer gate is app-scoped for the same key-space reason. The app root
    // rejecting must take the app's entries down and leave the mount's standing.
    await withContentMount(contentRepo());
    setDirty(h, [MDX_METADATA_REPO_PATH]);

    await h.bundler.preloadMDXMetadata();
    const meta = lastMetadataOf(h);

    expect(h.sentMessages.find((m) => m.type === 'artifact-distrust')?.data).toMatchObject({
      reason: 'writable-layer-mdx-metadata',
    });
    expect(meta.get(`${MOUNT}/entries/one.mdx`)).toMatchObject({ title: 'From mount' });
    // The app's forged entry did not seed; the live walk found no source for it either.
    expect(meta.has('/app/content/app-post.mdx')).toBe(false);
  });

  it('seeds the mount even when the app root ships no sidecar at all', async () => {
    // The app root's verdict decides whether `/app` live-walks. It must not decide whether
    // a mount's entries are kept — nothing else would ever produce them, because the live
    // walk is scoped to `APP_ROOT`.
    await withContentMount(contentRepo(), {
      'package.json': JSON.stringify({ name: 's', main: 'src/index.ts' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export default 1;\n',
      'content/app-post.mdx': '---\ntitle: Live app\n---\n\n# live\n',
    });

    await h.bundler.preloadMDXMetadata();
    const meta = lastMetadataOf(h);

    expect(meta.get(`${MOUNT}/entries/one.mdx`)).toMatchObject({ title: 'From mount' });
    // …and the `/app` live walk still ran.
    expect(meta.get('/app/content/app-post.mdx')).toMatchObject({ title: 'Live app' });
  });
});
