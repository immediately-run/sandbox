import { CONTRIBUTE_MANIFEST_PATH, MDX_METADATA_SIDECAR_PATH } from '@immediately-run/platform-constants';

import {
  contributeManifest as manifest,
  createBundlerHarness,
  lastMetadataOf,
  mountInMemoryFs,
  setDirty,
  type BundlerHarness,
} from '../testHarness/bundlerHarness';

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
const contentRepo = (
  over: { sidecar?: string; srcSha?: string; manifest?: boolean; malformedEntry?: boolean } = {},
): Record<string, string> => ({
  ...(over.manifest === false
    ? {}
    : {
        [CONTRIBUTE_MANIFEST_PATH]: manifest([
          { path: 'entries/one.mdx', sha: 'sha-one' },
          { path: 'entries/bad.mdx', sha: 'sha-bad' },
        ]),
      }),
  [MDX_METADATA_SIDECAR_PATH]:
    over.sidecar ??
    JSON.stringify({
      schemaVersion: 1,
      files: {
        '/entries/one.mdx': { srcSha: over.srcSha ?? 'sha-one', frontmatter: { title: 'From mount', tags: ['w'] } },
        // A row the shared validator rejects: `frontmatter` must be an object.
        ...(over.malformedEntry ? { '/entries/bad.mdx': { srcSha: 'sha-bad', frontmatter: 'not an object' } } : {}),
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

  it('names the ROOT of a dropped entry, so a repo-relative key is still attributable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withContentMount(contentRepo({ malformedEntry: true }));

      await h.bundler.preloadMDXMetadata();

      // The good row still seeds — one bad entry costs only itself.
      expect(lastMetadataOf(h).get(`${MOUNT}/entries/one.mdx`)).toMatchObject({ title: 'From mount' });
      expect(lastMetadataOf(h).has(`${MOUNT}/entries/bad.mdx`)).toBe(false);
      // …and the drop names which root carried it. `/entries/bad.mdx` alone would be
      // ambiguous the moment a second root can seed, which is the whole reason drops
      // carry a root at all.
      const said = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('dropped'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(`${MOUNT} /entries/bad.mdx: entry-frontmatter`);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not prefix an /app drop with a root, so the app-only log is unchanged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h = await createBundlerHarness({
        ...APP_FIXTURE,
        [CONTRIBUTE_MANIFEST_PATH]: manifest([{ path: 'content/app-bad.mdx', sha: 'sha-bad' }]),
        [MDX_METADATA_SIDECAR_PATH]: JSON.stringify({
          schemaVersion: 1,
          files: { '/content/app-bad.mdx': { srcSha: 'sha-bad', frontmatter: 'not an object' } },
        }),
      });

      await h.bundler.preloadMDXMetadata();

      const said = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('dropped'));
      expect(said[0]).toContain('/content/app-bad.mdx: entry-frontmatter');
      expect(said[0]).not.toContain('/app /content/app-bad.mdx');
    } finally {
      warn.mockRestore();
    }
  });
});

// The reachability half. The rebase above is only worth having if something in the real boot
// sequence runs it for a non-`/app` root — and at the point `preloadMDXMetadata` fires (the
// app-root mount hook) nothing else has registered yet, because `registerDeclaredGitLibraries`
// runs later. `seedArtifacts` is where every declared root HAS registered, so the sidecars of
// the roots added since boot are read there.
/** One mount carrying two bundles, the inner one nested in the outer's subtree. Both sidecars
 *  describe `<MOUNT>/sub/entries/one.mdx` — the only way two roots can name one file. */
const NESTED_ROOTS: Record<string, string> = {
  [CONTRIBUTE_MANIFEST_PATH]: manifest([{ path: 'sub/entries/one.mdx', sha: 'sha-outer' }]),
  [MDX_METADATA_SIDECAR_PATH]: JSON.stringify({
    schemaVersion: 1,
    files: { '/sub/entries/one.mdx': { srcSha: 'sha-outer', frontmatter: { title: 'Outer' } } },
  }),
  [`sub/${CONTRIBUTE_MANIFEST_PATH}`]: manifest([{ path: 'entries/one.mdx', sha: 'sha-inner' }]),
  [`sub/${MDX_METADATA_SIDECAR_PATH}`]: JSON.stringify({
    schemaVersion: 1,
    files: { '/entries/one.mdx': { srcSha: 'sha-inner', frontmatter: { title: 'Inner' } } },
  }),
};

describe('a root registered after boot is metadata-seeded when its artifacts are', () => {
  let h: BundlerHarness;
  let unmount: (() => void) | null = null;
  const EMPTY_CTX = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

  afterEach(async () => {
    unmount?.();
    unmount = null;
    if (h) await h.teardown();
  });

  it('seeds a root that did not exist when preloadMDXMetadata ran', async () => {
    h = await createBundlerHarness(APP_FIXTURE);
    // Boot order: the metadata preload happens BEFORE any library/content root registers.
    await h.bundler.preloadMDXMetadata();
    expect(lastMetadataOf(h).has(`${MOUNT}/entries/one.mdx`)).toBe(false);

    unmount = await mountInMemoryFs(MOUNT, contentRepo());
    h.bundler.artifactStore.addRoot(MOUNT);
    await h.bundler.seedArtifacts(EMPTY_CTX);

    expect(lastMetadataOf(h).get(`${MOUNT}/entries/one.mdx`)).toMatchObject({ title: 'From mount' });
    // …and the app root's own entries are untouched by the later pass.
    expect(lastMetadataOf(h).get('/app/content/app-post.mdx')).toEqual({ title: 'From app' });
  });

  it('reads each root once, so the later pass does not re-log the app root`s drops', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h = await createBundlerHarness({
        ...APP_FIXTURE,
        [CONTRIBUTE_MANIFEST_PATH]: manifest([{ path: 'content/app-bad.mdx', sha: 'sha-bad' }]),
        [MDX_METADATA_SIDECAR_PATH]: JSON.stringify({
          schemaVersion: 1,
          files: { '/content/app-bad.mdx': { srcSha: 'sha-bad', frontmatter: 'not an object' } },
        }),
      });
      await h.bundler.preloadMDXMetadata();
      await h.bundler.seedArtifacts(EMPTY_CTX);

      // Once, from the boot pass. A second read would double every drop line and re-fire
      // every seeded entry through the metadata emitter.
      expect(warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('dropped'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('gives a key two NESTED roots claim to the INNERMOST, whatever order they registered in', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h = await createBundlerHarness(APP_FIXTURE);
      await h.bundler.preloadMDXMetadata();

      // `addRoot` permits nesting, and a nested pair is the one way two roots can join to
      // the same absolute key. `rootFor` — the innermost — is the rule `consult` attributes
      // a module's BYTES by, so the frontmatter has to follow it or one file's compiled
      // output and its metadata would name different roots.
      unmount = await mountInMemoryFs(MOUNT, NESTED_ROOTS);
      // Registered OUTER first — the order that, under a first-writer-wins rule, would have
      // handed the key to the outer root.
      h.bundler.artifactStore.addRoot(MOUNT);
      h.bundler.artifactStore.addRoot(`${MOUNT}/sub`);
      await h.bundler.seedArtifacts(EMPTY_CTX);

      const key = `${MOUNT}/sub/entries/one.mdx`;
      // The INNER root owns it, though the outer registered first, and the outer's losing
      // entry is on the record instead of silently vanishing.
      expect(lastMetadataOf(h).get(key)).toEqual({ title: 'Inner' });
      const said = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('more than one artifact root'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(key);
    } finally {
      warn.mockRestore();
    }
  });

  it('…and reaches the same answer when the INNER root registers first', async () => {
    // The whole point of arbitrating by `rootFor` rather than by first-writer-wins: the
    // outcome is a property of the paths, not of the order two mounts happened to arrive in.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h = await createBundlerHarness(APP_FIXTURE);
      await h.bundler.preloadMDXMetadata();
      unmount = await mountInMemoryFs(MOUNT, NESTED_ROOTS);
      h.bundler.artifactStore.addRoot(`${MOUNT}/sub`);
      h.bundler.artifactStore.addRoot(MOUNT);
      await h.bundler.seedArtifacts(EMPTY_CTX);

      expect(lastMetadataOf(h).get(`${MOUNT}/sub/entries/one.mdx`)).toEqual({ title: 'Inner' });
    } finally {
      warn.mockRestore();
    }
  });
});
