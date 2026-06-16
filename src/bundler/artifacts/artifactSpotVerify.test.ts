import { transformFile, TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// G2-6 [harness]: mandatory spot-verification (PRETRANSPILED_ARTIFACTS_SPEC §5.7).
// Re-transpiles consumed artifacts in-process (the embedded chain, not the worker)
// and byte-compares — so these tests don't touch the one-per-file babel loopback.

const UTIL_SOURCE = `export const x = 42;\n`;
const COMMIT = 'c'.repeat(40);
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

const genuineArtifact = async (): Promise<string> => {
  const r = await transformFile({ path: '/app/src/util.ts', code: UTIL_SOURCE });
  if ('error' in r) throw new Error('fixture: util.ts failed to transform');
  return r.code;
};

const fixtureWith = (artifactContent: string): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'g26', main: 'src/util.ts' }),
  'src/util.ts': UTIL_SOURCE,
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    commitSha: COMMIT,
    entries: [{ path: 'src/util.ts', sha: 'sha-util', type: 'blob' }],
  }),
  '.immediately.run/artifacts/index.json': JSON.stringify({
    schemaVersion: 1,
    toolchain: {
      transpiler: '@immediately-run/transpiler',
      version: TRANSPILER_VERSION,
      toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
      preset: 'react',
    },
    files: { '/src/util.ts': { srcSha: 'sha-util', out: 'transpiled/src/util.ts.js', deps: [] } },
  }),
  '.immediately.run/artifacts/transpiled/src/util.ts.js': artifactContent,
});

describe('G2-6 spot-verification', () => {
  let h: BundlerHarness;
  afterEach(() => h?.teardown());

  const seedAndConsume = async (fixtureContent: string) => {
    h = await createBundlerHarness(fixtureWith(fixtureContent));
    expect((await h.bundler.artifactStore.seed(EMPTY_DIRTY)).seeded).toBe(1);
    // a consult marks it consumed (the spot-verify universe)
    expect(await h.bundler.artifactStore.consult('/app/src/util.ts')).not.toBeNull();
    expect(h.bundler.artifactStore.consumedCount()).toBe(1);
  };

  it('passes a genuine artifact (= transpile(source))', async () => {
    await seedAndConsume(await genuineArtifact());
    const verdict = await h.bundler.artifactStore.spotVerify();
    expect(verdict.tampered).toBe(false);
    expect(verdict.sampled).toBe(1);
    // still consumable — nothing discarded
    expect(await h.bundler.artifactStore.consult('/app/src/util.ts')).not.toBeNull();
  });

  it('detects a tampered artifact and discards the WHOLE section', async () => {
    await seedAndConsume('/* TAMPERED — not transpile(source) */ exports.x = 1;\n');
    const verdict = await h.bundler.artifactStore.spotVerify();
    expect(verdict.tampered).toBe(true);
    expect(verdict.path).toBe('/app/src/util.ts');
    // discarded → no longer consultable (live transpile from here)
    expect(await h.bundler.artifactStore.consult('/app/src/util.ts')).toBeNull();
    expect(h.bundler.artifactStore.getCommitSha()).toBe(COMMIT);
  });

  it('runSpotVerify reports an artifact-distrust message to the parent', async () => {
    await seedAndConsume('/* TAMPERED */ exports.x = 1;\n');
    await h.bundler.runSpotVerify();
    const distrust = h.sentMessages.find((m) => m.type === 'artifact-distrust');
    expect(distrust).toBeDefined();
    expect(distrust?.data).toMatchObject({ commitSha: COMMIT, reason: 'spot-verify-mismatch' });
  });

  it('runSpotVerify is silent for a genuine artifact', async () => {
    await seedAndConsume(await genuineArtifact());
    await h.bundler.runSpotVerify();
    expect(h.sentMessages.find((m) => m.type === 'artifact-distrust')).toBeUndefined();
  });

  it("the parent's distrust mark makes seeding a no-op", async () => {
    h = await createBundlerHarness(fixtureWith(await genuineArtifact()));
    h.bundler.artifactStore.markDistrusted(); // parent's §5.7 mark for this commit
    expect((await h.bundler.artifactStore.seed(EMPTY_DIRTY)).seeded).toBe(0);
    expect(await h.bundler.artifactStore.consult('/app/src/util.ts')).toBeNull();
  });
});
