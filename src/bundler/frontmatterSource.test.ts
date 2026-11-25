import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MDX_METADATA_SCHEMA_VERSION } from '@immediately-run/platform-constants';
import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { extractMetadata } from './bundler';
import { EMBEDDED_TOOLCHAIN_HASH } from './artifacts/embeddedToolchainHash';
import { isFrontmatterSource } from './frontmatterSource';
import {
  contributeManifest as manifest,
  createBundlerHarness,
  lastMetadataOf,
  setDirty,
  type BundlerHarness,
} from './testHarness/bundlerHarness';

// R3-1368: the metadata store indexes plain `.md` pages beside `.mdx`, so a content
// bundle kept as Markdown — an Open Knowledge Format bundle is a folder of `.md` files
// with YAML frontmatter — exposes its frontmatter to collections, tag pages and the
// metadata query tool.

// A real OKF page (Google's GA4 sample, Apache-2.0), frozen in `test-fixtures/okf-ga4`.
const OKF_EVENTS = readFileSync(join(__dirname, '..', '..', 'test-fixtures', 'okf-ga4', 'events_.md'), 'utf-8');

const EVENTS_ARTIFACT = '/* pre-transpiled events_.md */ exports.default = function () { return null; };\n';
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'okf-fixture', main: 'src/index.ts' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': 'export default 1;\n',
};

describe('isFrontmatterSource', () => {
  it.each(['content/post.mdx', '/app/content/post.mdx', 'content/tables/events_.md', '/app/README.md', 'a.md'])(
    'indexes %s',
    (path) => {
      expect(isFrontmatterSource(path)).toBe(true);
    },
  );

  // Case-sensitive like the CLI's sidecar emitter; a different extension, a suffix after
  // the extension, or a directory named `md` is not a Markdown page.
  it.each([
    'content/post.MD',
    'content/post.Mdx',
    'content/post.markdown',
    'content/post.mdx.js',
    'content/post.md.bak',
    'content/md/index.ts',
    'src/App.tsx',
    'README',
  ])('does not index %s', (path) => {
    expect(isFrontmatterSource(path)).toBe(false);
  });
});

describe('extractMetadata reads plain Markdown frontmatter', () => {
  it('parses a real OKF page, nested maps and lists of maps included', () => {
    const parsed = extractMetadata({ path: '/app/okf/tables/events_.md', code: OKF_EVENTS });
    expect(parsed?.data).toMatchObject({
      type: 'BigQuery Table',
      title: 'GA4 Events Export',
      tags: ['analytics', 'e-commerce', 'ga4', 'sharded-tables'],
      generated: { by: 'reference_agent/gemini-3.5-flash', at: '2026-07-10T21:15:20+00:00' },
    });
    expect((parsed?.data.sources as unknown[]).length).toBe(3);
  });

  it('still ignores the same bytes under a path the store does not index', () => {
    expect(extractMetadata({ path: '/app/okf/tables/events_.txt', code: OKF_EVENTS })).toBeNull();
  });

  it('still drops a page with no frontmatter (an OKF index.md has none)', () => {
    expect(
      extractMetadata({ path: '/app/okf/index.md', code: '# Subdirectories\n\n* [tables](tables/index.md)\n' }),
    ).toBeNull();
  });
});

describe('the metadata store indexes .md beside .mdx', () => {
  let h: BundlerHarness;
  afterEach(async () => {
    if (h) await h.teardown();
  });

  it('the live walk (no sidecar) indexes a mixed collection', async () => {
    h = await createBundlerHarness({
      ...BASE,
      'content/post.mdx': '---\ntitle: An MDX post\n---\n\n# post\n',
      'content/okf/tables/events_.md': OKF_EVENTS,
      'content/okf/index.md': '# Subdirectories\n\n* [tables](tables/index.md)\n',
      'README.md': '# A readme with no frontmatter\n',
    });

    await h.bundler.preloadMDXMetadata();
    const meta = lastMetadataOf(h);

    expect(meta.get('/app/content/post.mdx')).toMatchObject({ title: 'An MDX post' });
    expect(meta.get('/app/content/okf/tables/events_.md')).toMatchObject({
      type: 'BigQuery Table',
      title: 'GA4 Events Export',
    });
    // Pages with no frontmatter stay out, whatever their extension.
    expect(meta.has('/app/content/okf/index.md')).toBe(false);
    expect(meta.has('/app/README.md')).toBe(false);
  });

  it('a cached boot re-scans an edited .md live, as it does an edited .mdx', async () => {
    h = await createBundlerHarness({
      ...BASE,
      '.immediately.run/contribute-manifest.json': manifest([
        { path: 'content/post.mdx', sha: 'sha-post' },
        { path: 'content/notes/edited.md', sha: 'sha-edited' },
      ]),
      // A sidecar from a CLI that emits `.mdx` rows only.
      '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
        schemaVersion: MDX_METADATA_SCHEMA_VERSION,
        files: { '/content/post.mdx': { srcSha: 'sha-post', frontmatter: { title: 'Seeded' } } },
      }),
      'content/post.mdx': '---\ntitle: Seeded\n---\n\n# post\n',
      'content/notes/edited.md': '---\ntitle: Edited note\n---\n\n# edited\n',
    });
    setDirty(h, ['/content/notes/edited.md']);

    await h.bundler.preloadMDXMetadata();
    const meta = lastMetadataOf(h);

    expect(meta.get('/app/content/post.mdx')).toEqual({ title: 'Seeded' });
    expect(meta.get('/app/content/notes/edited.md')).toEqual({
      title: 'Edited note',
      headings: [{ id: 'edited', text: 'edited', depth: 1 }],
    });
    // The seeded path still never walks the tree.
    expect(h.portOps.filter((op) => op.method === 'readdir')).toHaveLength(0);
  });

  // A cached repo: the page is a manifest member with a pre-transpiled artifact, and the
  // sidecar carries `sidecarRows`. Reading the page is then a consult HIT, the path a
  // clean page takes on every cached boot.
  const cachedFixture = (sidecarRows: Record<string, unknown>): Record<string, string> => ({
    ...BASE,
    'content/post.mdx': '---\ntitle: An MDX post\n---\n',
    'okf/tables/events_.md': OKF_EVENTS,
    '.immediately.run/contribute-manifest.json': JSON.stringify({
      schemaVersion: 1,
      commitSha: 'a'.repeat(40),
      entries: [
        { path: 'src/index.ts', sha: 'sha-index', type: 'blob' },
        { path: 'content/post.mdx', sha: 'sha-post', type: 'blob' },
        { path: 'okf/tables/events_.md', sha: 'sha-events', type: 'blob' },
      ],
    }),
    '.immediately.run/artifacts/index.json': JSON.stringify({
      schemaVersion: 1,
      toolchain: {
        transpiler: '@immediately-run/transpiler',
        version: TRANSPILER_VERSION,
        toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
        preset: 'react',
      },
      files: {
        '/okf/tables/events_.md': { srcSha: 'sha-events', out: 'transpiled/okf/tables/events_.md.js', deps: [] },
      },
    }),
    '.immediately.run/artifacts/transpiled/okf/tables/events_.md.js': EVENTS_ARTIFACT,
    '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
      schemaVersion: MDX_METADATA_SCHEMA_VERSION,
      files: sidecarRows,
    }),
  });
  const EVENTS_KEY = '/app/okf/tables/events_.md';
  const POST_ROW = { '/content/post.mdx': { srcSha: 'sha-post', frontmatter: { title: 'An MDX post' } } };

  const bootCachedAndRead = async (sidecarRows: Record<string, unknown>): Promise<void> => {
    h = await createBundlerHarness(cachedFixture(sidecarRows), { forCompile: true });
    expect((await h.bundler.artifactStore.seed(EMPTY_DIRTY)).seeded).toBe(1);
    await h.bundler.preloadMDXMetadata();
    const mod = await h.bundler.transformModule(EVENTS_KEY);
    expect(mod.compiled).toBe(EVENTS_ARTIFACT); // served from the artifact: a consult HIT
  };

  it('a sidecar .md row seeds, and a cached read of the page keeps it', async () => {
    // The row the CLI's sidecar emits once it covers `.md`.
    await bootCachedAndRead({
      ...POST_ROW,
      '/okf/tables/events_.md': {
        srcSha: 'sha-events',
        frontmatter: extractMetadata({ path: '/okf/tables/events_.md', code: OKF_EVENTS })?.data,
      },
    });
    expect(lastMetadataOf(h).get(EVENTS_KEY)).toMatchObject({ type: 'BigQuery Table', title: 'GA4 Events Export' });
  });

  it('a sidecar with .mdx rows only leaves a clean cached .md unindexed, even after it is read', async () => {
    // The gap until the CLI's sidecar carries `.md` rows: a consult HIT never re-reads
    // the source, so nothing on the cached path parses this page's frontmatter.
    await bootCachedAndRead(POST_ROW);
    expect(lastMetadataOf(h).get('/app/content/post.mdx')).toEqual({ title: 'An MDX post' });
    expect(lastMetadataOf(h).has(EVENTS_KEY)).toBe(false);
  });

  it('a live re-read of a seeded .md page replaces the row and never drops it', async () => {
    // A page with no artifact (or an edited one) is compiled live, and `_transformModule`
    // parses its frontmatter on that consult miss. That compile runs the ESM-only MDX
    // chain jest cannot load, so the test calls the read it makes, `refreshMetadata`.
    // A sandbox that indexed `.mdx` only deleted the seeded row at this point.
    h = await createBundlerHarness({
      ...BASE,
      '.immediately.run/contribute-manifest.json': manifest([{ path: 'okf/tables/events_.md', sha: 'sha-events' }]),
      '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
        schemaVersion: MDX_METADATA_SCHEMA_VERSION,
        files: {
          '/okf/tables/events_.md': {
            srcSha: 'sha-events',
            frontmatter: extractMetadata({ path: '/okf/tables/events_.md', code: OKF_EVENTS })?.data,
          },
        },
      }),
      'okf/tables/events_.md': OKF_EVENTS,
    });
    await h.bundler.preloadMDXMetadata();
    expect(lastMetadataOf(h).get(EVENTS_KEY)).toMatchObject({ type: 'BigQuery Table' });

    (h.bundler as unknown as { refreshMetadata(path: string, source: string): void }).refreshMetadata(
      EVENTS_KEY,
      OKF_EVENTS,
    );
    expect(lastMetadataOf(h).get(EVENTS_KEY)).toMatchObject({
      type: 'BigQuery Table',
      title: 'GA4 Events Export',
      headings: expect.any(Array),
    });
  });
});
