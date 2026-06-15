import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// G2-5 [harness]: end-to-end seeding / consult / write-through / reset-delete
// (PRETRANSPILED_ARTIFACTS_SPEC §5.1, §5.3). Drives the REAL bundler over the
// in-process harness (the babel loopback's `transformRequests` spy is the
// "zero babel transforms" instrument).

const UTIL_ARTIFACT = '/* pre-transpiled util */ exports.x = 42;\n';
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

const baseFixture = (over: { toolchainHash?: string; srcShaUtil?: string } = {}): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'g25', main: 'src/index.ts' }),
  'src/index.ts': `import { x } from './util';\nexport const y = x + 1;\n`,
  'src/util.ts': `export const x = 42;\n`,
  '.tinkerable/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    entries: [
      { path: 'src/index.ts', sha: 'sha-index', type: 'blob' },
      { path: 'src/util.ts', sha: 'sha-util', type: 'blob' },
    ],
  }),
  '.tinkerable/artifacts/index.json': JSON.stringify({
    schemaVersion: 1,
    toolchain: {
      transpiler: '@immediately-run/transpiler',
      version: TRANSPILER_VERSION,
      toolchainHash: over.toolchainHash ?? EMBEDDED_TOOLCHAIN_HASH,
      preset: 'react',
    },
    files: {
      '/src/util.ts': { srcSha: over.srcShaUtil ?? 'sha-util', out: 'transpiled/src/util.ts.js', deps: [] },
    },
  }),
  '.tinkerable/artifacts/transpiled/src/util.ts.js': UTIL_ARTIFACT,
});

describe('G2-5 artifact seeding + consult', () => {
  let h: BundlerHarness;
  afterEach(() => h?.teardown());

  it('seeds a covered source and consults it with ZERO babel transforms', async () => {
    h = await createBundlerHarness(baseFixture(), { forCompile: true });
    const result = await h.bundler.artifactStore.seed(EMPTY_DIRTY);
    expect(result.seeded).toBe(1);

    h.babel.resetTransformRequests();
    const mod = await h.bundler.transformModule('/app/src/util.ts');
    expect(mod.compiled).toBe(UTIL_ARTIFACT);
    expect(h.babel.transformRequests).not.toContain('/app/src/util.ts');
  });

  it('reset-delete drops the /transpiled entry so it can never resurrect', async () => {
    // resetCompilation() calls artifactStore.invalidate(filepath) (Module.ts);
    // exercise that mechanism directly — the non-hot resetCompilation path also
    // calls location.reload(), which jsdom can't run.
    h = await createBundlerHarness(baseFixture(), { forCompile: true });
    await h.bundler.artifactStore.seed(EMPTY_DIRTY);

    const mod = await h.bundler.transformModule('/app/src/util.ts'); // seeded HIT
    expect(mod.compiled).toBe(UTIL_ARTIFACT);
    // a fresh consult would still hit before invalidation
    expect(await h.bundler.artifactStore.consult('/app/src/util.ts')).not.toBeNull();

    h.bundler.artifactStore.invalidate('/app/src/util.ts'); // §5.3 reset-delete
    // consult awaits the in-flight delete, then sees the entry gone
    expect(await h.bundler.artifactStore.consult('/app/src/util.ts')).toBeNull();
  });

  it('a dirty path is never seeded (a previous-session edit)', async () => {
    h = await createBundlerHarness(baseFixture(), { forCompile: true });
    const result = await h.bundler.artifactStore.seed({
      dirtySet: new Set(['/src/util.ts']),
      writableLayer: new Set(),
    });
    expect(result.seeded).toBe(0);
    expect(await h.bundler.artifactStore.consult('/app/src/util.ts')).toBeNull();
  });

  it('a toolchainHash mismatch ignores ALL artifacts (§4.4 stamp gate)', async () => {
    h = await createBundlerHarness(baseFixture({ toolchainHash: 'deadbeef'.repeat(8) }), { forCompile: true });
    const result = await h.bundler.artifactStore.seed(EMPTY_DIRTY);
    expect(result.seeded).toBe(0);
  });

  it('a srcSha mismatch skips that file (its source changed vs the artifact)', async () => {
    h = await createBundlerHarness(baseFixture({ srcShaUtil: 'STALE' }), { forCompile: true });
    const result = await h.bundler.artifactStore.seed(EMPTY_DIRTY);
    expect(result.seeded).toBe(0);
  });

  it('a writable-layer artifact rejects the WHOLE section (§5.1 PT2-4)', async () => {
    h = await createBundlerHarness(baseFixture(), { forCompile: true });
    const result = await h.bundler.artifactStore.seed({
      dirtySet: new Set(),
      writableLayer: new Set(['/.tinkerable/artifacts/transpiled/src/util.ts.js']),
    });
    expect(result.securityReject).toBe('writable-layer-artifact');
    expect(result.seeded).toBe(0);
  });
});
