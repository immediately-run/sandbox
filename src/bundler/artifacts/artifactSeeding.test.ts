import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';
import { formatStampMismatch } from './artifactIndex';

// G2-5 [harness]: end-to-end seeding / consult / write-through / reset-delete
// (PRETRANSPILED_ARTIFACTS_SPEC §5.1, §5.3). Drives the REAL bundler over the
// in-process harness (the babel loopback's `transformRequests` spy is the
// "zero babel transforms" instrument).

const UTIL_ARTIFACT = '/* pre-transpiled util */ exports.x = 42;\n';
const EMPTY_DIRTY = { dirtySet: new Set<string>(), writableLayer: new Set<string>() };

const baseFixture = (
  over: { toolchainHash?: string; toolchainVersion?: string; srcShaUtil?: string } = {},
): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'g25', main: 'src/index.ts' }),
  'src/index.ts': `import { x } from './util';\nexport const y = x + 1;\n`,
  'src/util.ts': `export const x = 42;\n`,
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    entries: [
      { path: 'src/index.ts', sha: 'sha-index', type: 'blob' },
      { path: 'src/util.ts', sha: 'sha-util', type: 'blob' },
    ],
  }),
  '.immediately.run/artifacts/index.json': JSON.stringify({
    schemaVersion: 1,
    toolchain: {
      transpiler: '@immediately-run/transpiler',
      version: over.toolchainVersion ?? TRANSPILER_VERSION,
      toolchainHash: over.toolchainHash ?? EMBEDDED_TOOLCHAIN_HASH,
      preset: 'react',
    },
    files: {
      '/src/util.ts': { srcSha: over.srcShaUtil ?? 'sha-util', out: 'transpiled/src/util.ts.js', deps: [] },
    },
  }),
  '.immediately.run/artifacts/transpiled/src/util.ts.js': UTIL_ARTIFACT,
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

  // R3-843 — the mismatch must not just refuse; it must say WHY (the refusal was
  // silent at the default level, and the cache→consume round trip went dark).
  it('a stamped-mismatch index seeds zero AND carries the reason (R3-843)', async () => {
    h = await createBundlerHarness(baseFixture({ toolchainHash: 'deadbeef'.repeat(8) }), { forCompile: true });
    const result = await h.bundler.artifactStore.seed(EMPTY_DIRTY);
    expect(result.seeded).toBe(0);
    expect(result.stampMismatches).toHaveLength(1);
    const { root, mismatch } = result.stampMismatches![0];
    expect(root).toBe('/app');
    // Same version, wrong bytes: the report names ONLY the hash field.
    expect(mismatch.fields).toEqual(['toolchainHash']);
    expect(mismatch.stamped.toolchainHash).toBe('deadbeef'.repeat(8));
    expect(mismatch.embedded.toolchainHash).toBe(EMBEDDED_TOOLCHAIN_HASH);
  });

  it('a version-only drift is reported as the version field (a stale pipeline pin)', async () => {
    h = await createBundlerHarness(baseFixture({ toolchainVersion: '0.0.0-OLD' }), { forCompile: true });
    const result = await h.bundler.artifactStore.seed(EMPTY_DIRTY);
    expect(result.seeded).toBe(0);
    expect(result.stampMismatches![0].mismatch.fields).toEqual(['version']);
  });

  it('a version+hash drift reports both fields', async () => {
    h = await createBundlerHarness(
      baseFixture({ toolchainVersion: '0.0.0-OLD', toolchainHash: 'deadbeef'.repeat(8) }),
      { forCompile: true },
    );
    const result = await h.bundler.artifactStore.seed(EMPTY_DIRTY);
    expect(result.stampMismatches![0].mismatch.fields).toEqual(['version', 'toolchainHash']);
  });

  it('formatStampMismatch pins the line a drill greps for', () => {
    const line = formatStampMismatch('/app', {
      stamped: {
        transpiler: '@immediately-run/transpiler',
        version: '0.9.0',
        toolchainHash: 'cb2772e6' + '0'.repeat(56),
        preset: 'react',
      },
      embedded: { version: '0.9.1', toolchainHash: '1780f8e8' + '0'.repeat(56) },
      fields: ['version', 'toolchainHash'],
    });
    expect(line).toBe(
      '[ir-artifacts] /app: toolchain stamp mismatch ' +
        '(version: zip 0.9.0 ≠ runtime 0.9.1; toolchainHash: zip cb2772e60000… ≠ runtime 1780f8e80000…) — ' +
        "the zip's artifacts are ignored; live-transpiling",
    );
  });

  it('a matching stamp still seeds (the reason path did not narrow the gate)', async () => {
    h = await createBundlerHarness(baseFixture(), { forCompile: true });
    const result = await h.bundler.artifactStore.seed(EMPTY_DIRTY);
    expect(result.seeded).toBe(1);
    expect(result.stampMismatches).toBeUndefined();
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
      writableLayer: new Set(['/.immediately.run/artifacts/transpiled/src/util.ts.js']),
    });
    expect(result.securityReject).toBe('writable-layer-artifact');
    expect(result.seeded).toBe(0);
  });
});
