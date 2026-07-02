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

import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

const POST_PATH = '/app/content/post.mdx';
const ARTIFACT = '/* pre-transpiled post.mdx */ export default function(){ return null; }\n';
const SOURCE = '---\ntitle: Real\n---\n\n# real post\n';
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'sv', main: 'src/index.ts' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': 'export default 1;\n',
  'content/post.mdx': SOURCE,
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    commitSha: 'a'.repeat(40),
    entries: [
      { path: 'src/index.ts', sha: 'sha-index', type: 'blob' },
      { path: 'content/post.mdx', sha: 'sha-post', type: 'blob' },
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
    files: { '/content/post.mdx': { srcSha: 'sha-post', out: 'transpiled/content/post.mdx.js', deps: [] } },
  }),
  '.immediately.run/artifacts/transpiled/content/post.mdx.js': ARTIFACT,
};

const setMeta = (h: BundlerHarness, v: Record<string, unknown>): void =>
  void (h.bundler as unknown as { lastMetadata: Map<string, unknown> }).lastMetadata.set(POST_PATH, v);

describe('G-MDX-3b — idle spot-verify extended to frontmatter (§3)', () => {
  let h: BundlerHarness;
  beforeEach(() => {
    // Byte check passes: the "recompile" reproduces the seeded artifact exactly.
    (transformFile as jest.Mock).mockResolvedValue({ code: ARTIFACT, deps: [] });
  });
  afterEach(async () => {
    (transformFile as jest.Mock).mockReset();
    if (h) await h.teardown();
  });

  const seedConsume = async () => {
    h = await createBundlerHarness(FIXTURE, { forCompile: true });
    expect((await h.bundler.artifactStore.seed(EMPTY_DIRTY)).seeded).toBe(1);
    // A consult marks the .mdx consumed → it enters the spot-verify universe.
    expect(await h.bundler.artifactStore.consult(POST_PATH)).not.toBeNull();
  };

  it('distrusts a FORGED sidecar frontmatter entry + emits a security event', async () => {
    await seedConsume();
    setMeta(h, { title: 'Forged' }); // ≠ parseFrontmatter(SOURCE) = { title: 'Real' }

    await h.bundler.runSpotVerify();

    // Section discarded → the .mdx is no longer consultable (live from here).
    expect(await h.bundler.artifactStore.consult(POST_PATH)).toBeNull();
    // Security event fired over the existing artifact-distrust channel.
    const distrust = h.sentMessages.find((m) => m.type === 'artifact-distrust');
    expect(distrust?.data).toMatchObject({ reason: 'spot-verify-mismatch' });
  });

  it('passes a GENUINE sidecar entry (= parseFrontmatter(source)) — no distrust', async () => {
    await seedConsume();
    setMeta(h, { title: 'Real' }); // matches the source frontmatter

    await h.bundler.runSpotVerify();

    expect(await h.bundler.artifactStore.consult(POST_PATH)).not.toBeNull();
    expect(h.sentMessages.find((m) => m.type === 'artifact-distrust')).toBeUndefined();
  });
});
