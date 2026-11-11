import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import {
  createBundlerHarness,
  EVAL_FIXTURE,
  installEvalGlobals,
  mountInMemoryFs,
  type BundlerHarness,
} from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// R3-1343 — the security-rejected-branch twin of artifactLibraryVariantMissing.boot.test.ts:
// the app root's §5.1 verdict must not mute the library's cold-cache line. One compile()
// harness per FILE (the babel loopback is one per module realm — see babelLoopback.ts),
// which is why this case is its own file rather than a second case there.
//
// §5.1/§8.14: an app seeding input present in the writable (COW) layer rejects the
// app's whole section, and the `seeded N` count line is else-scoped away — but a
// library's cold cache is independent of the app root's verdict (the same
// unconditional-in-both-branches rule as the stamp-mismatch loop, R3-843), so the
// variant line must still say why the library is cold.

/** The app fixture: a VALID artifact section, so the only anomaly is its index
 *  sitting in the writable layer (the §5.2 dirty set). */
const APP_WITH_ARTIFACTS: Record<string, string> = {
  ...EVAL_FIXTURE,
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    entries: [{ path: 'src/answer.ts', sha: 'sha-answer', type: 'blob' }],
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
      '/src/answer.ts': { srcSha: 'sha-answer', out: 'transpiled/src/answer.ts.js', deps: [] },
    },
  }),
  '.immediately.run/artifacts/transpiled/src/answer.ts.js': '/* app artifact */\n',
};

/** A variant-less library zip (the twin file's shape): valid stamp, sidecar, no
 *  `library` blocks — nothing seeds, nothing is byte-compared. */
const variantlessLibrary = (): Record<string, string> => ({
  'package.json': '{"name":"@scope/lib","version":"1.0.0","main":"src/greet.ts"}',
  'src/greet.ts': 'export const greet = () => "hi";\n',
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    commitSha: 'lib-commit-sha',
    entries: [{ path: 'src/greet.ts', sha: 'sha-greet', type: 'blob' }],
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
      '/src/greet.ts': { srcSha: 'sha-greet', out: 'transpiled/src/greet.ts.js', deps: [] },
    },
  }),
  '.immediately.run/artifacts/transpiled/src/greet.ts.js': '/* never served: no variant */\n',
});

describe('R3-1343 — the library-variant boot line (security-rejected branch)', () => {
  let h: BundlerHarness;
  let unmount: (() => void) | null = null;
  let lines: string[];

  beforeAll(async () => {
    const restoreGlobals = installEvalGlobals();
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      h = await createBundlerHarness(APP_WITH_ARTIFACTS, { forCompile: true });
      unmount = await mountInMemoryFs('/mnt/testlib', variantlessLibrary());
      await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/testlib');
      // The app root's seeding input in the writable layer → §5.1 rejects the app's
      // section ('writable-layer-artifact'); the count line below is else-scoped away.
      h.bundler.setDirtyPaths(['/.immediately.run/artifacts/index.json']);
      await h.bundler.compile();
      lines = spy.mock.calls.map((c) => String(c[0]));
    } finally {
      spy.mockRestore();
      restoreGlobals();
    }
  }, 30000);

  afterAll(async () => {
    unmount?.();
    unmount = null;
    await h.teardown();
  });

  it('still fires beside the rejection — the library verdict is independent', () => {
    expect(lines).toContain('[ir-artifacts] 1 library module(s) live-transpiled: no library variant in the zip');
  });

  it('while the seeded-count line is else-scoped away by the app root rejection', () => {
    expect(lines.some((l) => l.startsWith('[ir-artifacts] seeded '))).toBe(false);
  });
});
