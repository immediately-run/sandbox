// G-MDX-3b (§3): the idle spot-verify, extended to frontmatter. A covered `.mdx`
// served by the consult-HIT early-return never re-reads its source (verify-on-read
// is dead), so the ONLY runtime check that can catch a forged/divergent sidecar is
// the §5.7 idle spot-verify — which re-reads K sampled sources. Here we assert its
// frontmatter extension distrusts a forged entry and passes a genuine one.
//
// `transformFile` is mocked to return the seeded artifact bytes so the §5.7 BYTE
// check passes and control reaches the new frontmatter comparison — jest can't run
// the ESM-only `@mdx-js/mdx` the real `transformFile` would invoke for `.mdx`.
// `parseFrontmatter` stays REAL (requireActual), so the comparison is genuine.
jest.mock('@immediately-run/transpiler', () => {
  const actual = jest.requireActual('@immediately-run/transpiler');
  return { ...actual, transformFile: jest.fn() };
});

import { transformFile, TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { createBundlerHarness, lastMetadataOf, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

const ARTIFACT = '/* pre-transpiled post */ export default function(){ return null; }\n';
const SOURCE = '---\ntitle: Real\n---\n\n# real post\n';
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

// A covered page is either `.mdx` or plain `.md` (R3-1368): both are seeded from the
// sidecar, so both must be re-derived and compared here.
// `sidecar` is the frontmatter the cache-zip sidecar claims for the page; absent, the
// fixture ships no sidecar and the live walk fills the store.
const fixtureFor = (rel: string, sidecar?: Record<string, unknown>): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'sv', main: 'src/index.ts' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': 'export default 1;\n',
  [rel]: SOURCE,
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    commitSha: 'a'.repeat(40),
    entries: [
      { path: 'src/index.ts', sha: 'sha-index', type: 'blob' },
      { path: rel, sha: 'sha-post', type: 'blob' },
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
    files: { [`/${rel}`]: { srcSha: 'sha-post', out: `transpiled/${rel}.js`, deps: [] } },
  }),
  [`.immediately.run/artifacts/transpiled/${rel}.js`]: ARTIFACT,
  ...(sidecar && {
    '.immediately.run/artifacts/mdx-metadata.json': JSON.stringify({
      schemaVersion: 1,
      files: { [`/${rel}`]: { srcSha: 'sha-post', frontmatter: sidecar } },
    }),
  }),
});

describe.each(['content/post.mdx', 'content/post.md'])(
  'G-MDX-3b — idle spot-verify extended to frontmatter (§3): %s',
  (rel) => {
    const POST_PATH = `/app/${rel}`;

    let h: BundlerHarness;
    beforeEach(() => {
      // Byte check passes: the "recompile" reproduces the seeded artifact exactly.
      (transformFile as jest.Mock).mockResolvedValue({ code: ARTIFACT, deps: [] });
    });
    afterEach(async () => {
      (transformFile as jest.Mock).mockReset();
      if (h) await h.teardown();
    });

    // The store is filled by its real producer, `preloadMDXMetadata`: from the sidecar
    // when the fixture ships one, by the live walk when it does not.
    const seedConsume = async (sidecar?: Record<string, unknown>) => {
      h = await createBundlerHarness(fixtureFor(rel, sidecar), { forCompile: true });
      expect((await h.bundler.artifactStore.seed(EMPTY_DIRTY)).seeded).toBe(1);
      await h.bundler.preloadMDXMetadata();
      // A consult marks the page consumed → it enters the spot-verify universe.
      expect(await h.bundler.artifactStore.consult(POST_PATH)).not.toBeNull();
    };

    it('distrusts a FORGED sidecar frontmatter entry + emits a security event', async () => {
      await seedConsume({ title: 'Forged' }); // ≠ parseFrontmatter(SOURCE) = { title: 'Real' }

      await h.bundler.runSpotVerify();

      // Section discarded → the page is no longer consultable (live from here).
      expect(await h.bundler.artifactStore.consult(POST_PATH)).toBeNull();
      // Security event fired over the existing artifact-distrust channel.
      const distrust = h.sentMessages.find((m) => m.type === 'artifact-distrust');
      expect(distrust?.data).toMatchObject({ reason: 'spot-verify-mismatch' });
    });

    it('passes a GENUINE sidecar entry (= parseFrontmatter(source)) — no distrust', async () => {
      await seedConsume({ title: 'Real' }); // matches the source frontmatter

      await h.bundler.runSpotVerify();

      expect(await h.bundler.artifactStore.consult(POST_PATH)).not.toBeNull();
      expect(h.sentMessages.find((m) => m.type === 'artifact-distrust')).toBeUndefined();
    });

    it('does not compare a row the live walk wrote (no sidecar) — no distrust', async () => {
      // The walk's row carries the additive `headings` field, which a re-parse of the
      // source does not; it is the parser's own output, not a claim to check.
      await seedConsume();
      expect(lastMetadataOf(h).get(POST_PATH)).toMatchObject({ title: 'Real', headings: [expect.anything()] });

      await h.bundler.runSpotVerify();

      expect(await h.bundler.artifactStore.consult(POST_PATH)).not.toBeNull();
      expect(h.sentMessages.find((m) => m.type === 'artifact-distrust')).toBeUndefined();
    });
  },
);
