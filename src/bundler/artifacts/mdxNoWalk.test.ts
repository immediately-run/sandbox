import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';

// G-MDX-3 perf gate §4 (no-walk, §1.3): booting a large MDX repo from the zip does
// ZERO APP_ROOT directory-walk / source-read ops for clean files — the sidecar
// enumerates the set, so the recursive readdir+stat+read across the COW port is
// skipped. This is the in-process, deterministic proxy for the throttled-profile
// cold-boot win (each avoided op is a parent↔iframe port round-trip; the D-PTA-1
// lesson is that port round-trips, not transpile, dominate boot). The end-to-end
// throttled-profile timing gate lives in site-main's Playwright harness (perf/).
//
// The harness Port-traffic spy records every /app fs op as { method, path } (paths
// mount-relative), so we count `readdir` (the unambiguous directory-walk signal) and
// `.mdx` source reads on the two `preloadMDXMetadata` paths.

// A "large" MDX repo: several .mdx across nested dirs — enough that a walk is many ops.
const MDX_FILES = [
  'content/a.mdx',
  'content/b.mdx',
  'content/c.mdx',
  'content/guides/getting-started.mdx',
  'content/guides/advanced.mdx',
  'content/blog/one.mdx',
  'content/blog/two.mdx',
  'content/blog/three.mdx',
];
const sourceFor = (rel: string) => `---\ntitle: ${rel}\n---\n\n# ${rel}\n`;

const manifest = () =>
  JSON.stringify({
    schemaVersion: 1,
    entries: [
      { path: 'src/index.ts', sha: 'sha-index', type: 'blob' },
      ...MDX_FILES.map((p) => ({ path: p, sha: `sha:${p}`, type: 'blob' })),
    ],
  });
const sidecar = () =>
  JSON.stringify({
    schemaVersion: 1,
    files: Object.fromEntries(MDX_FILES.map((p) => [`/${p}`, { srcSha: `sha:${p}`, frontmatter: { title: p } }])),
  });

const base = (): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'big-mdx', main: 'src/index.ts' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': 'export default 1;\n',
  '.immediately.run/contribute-manifest.json': manifest(),
  ...Object.fromEntries(MDX_FILES.map((p) => [p, sourceFor(p)])),
});

const lastMetadataOf = (h: BundlerHarness): Map<string, unknown> =>
  (h.bundler as unknown as { lastMetadata: Map<string, unknown> }).lastMetadata;
const readdirOps = (h: BundlerHarness) => h.portOps.filter((op) => op.method === 'readdir');
const mdxReads = (h: BundlerHarness) =>
  h.portOps.filter((op) => op.method === 'read' && op.path.endsWith('.mdx'));

describe('G-MDX-3 §4 — no-walk: sidecar seed skips the APP_ROOT MDX walk', () => {
  let h: BundlerHarness;
  afterEach(async () => {
    if (h) await h.teardown();
  });

  it('sidecar path: ZERO readdir + ZERO .mdx source reads (whole set seeded from JSON)', async () => {
    h = await createBundlerHarness({ ...base(), '.immediately.run/artifacts/mdx-metadata.json': sidecar() });
    h.resetSpies();

    await h.bundler.preloadMDXMetadata();

    // The store is fully populated…
    expect(lastMetadataOf(h).size).toBe(MDX_FILES.length);
    // …with NO directory walk and NO source read of any clean .mdx.
    expect(readdirOps(h)).toHaveLength(0);
    expect(mdxReads(h)).toHaveLength(0);
  });

  it('control (no sidecar): the live walk DOES readdir + read every .mdx source', async () => {
    h = await createBundlerHarness(base()); // no sidecar → fall through to the walk
    h.resetSpies();

    await h.bundler.preloadMDXMetadata();

    expect(lastMetadataOf(h).size).toBe(MDX_FILES.length);
    expect(readdirOps(h).length).toBeGreaterThan(0); // the recursive directory walk
    expect(mdxReads(h)).toHaveLength(MDX_FILES.length); // every source read across the port
  });

  it('the sidecar path issues far fewer /app port ops than the walk (the boot win)', async () => {
    h = await createBundlerHarness({ ...base(), '.immediately.run/artifacts/mdx-metadata.json': sidecar() });
    h.resetSpies();
    await h.bundler.preloadMDXMetadata();
    const seedOps = h.portOps.length;
    await h.teardown();

    h = await createBundlerHarness(base());
    h.resetSpies();
    await h.bundler.preloadMDXMetadata();
    const walkOps = h.portOps.length;

    // Seed reads a couple of JSONs; the walk pays readdir+stat+read per file/dir.
    expect(seedOps).toBeLessThan(walkOps);
  });

  it('only a MODIFIED (dirty) .mdx is read live on the sidecar path — still no walk', async () => {
    h = await createBundlerHarness({ ...base(), '.immediately.run/artifacts/mdx-metadata.json': sidecar() });
    // Edit one file's frontmatter and mark it dirty (parent-attested).
    const dirty = 'content/b.mdx';
    (h.bundler as unknown as { dirtyPaths: Set<string> }).dirtyPaths = new Set([`/${dirty}`]);
    h.resetSpies();

    await h.bundler.preloadMDXMetadata();

    // No walk, and exactly the one dirty source re-read live (the rest seeded from JSON).
    expect(readdirOps(h)).toHaveLength(0);
    expect(mdxReads(h).map((op) => op.path)).toEqual([`/${dirty}`]);
    expect(lastMetadataOf(h).size).toBe(MDX_FILES.length);
  });
});
