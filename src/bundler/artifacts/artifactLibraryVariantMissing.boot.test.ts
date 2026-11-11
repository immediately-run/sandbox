import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import {
  createBundlerHarness,
  EVAL_FIXTURE,
  installEvalGlobals,
  mountInMemoryFs,
  type BundlerHarness,
} from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// R3-1343 — the compile-path join for the library-variant `[ir-artifacts]` lines: a
// REAL compile() with a variant-less git library mounted, console.info spied. The
// suites that drive the variant-aware seeding (artifactSpotVerifyLibraryRoot,
// artifactLibraryRoot) call seedArtifacts() directly, which never reaches these lines
// — they live in compile()'s first-load block — so without this file the
// default-visible diagnostic this item ships would ship untested (the same join
// artifactStampMismatch.boot.test.ts covers for the stamp-mismatch line, R3-843).
//
// Nothing seeds in this fixture (the zip carries no variants), so no artifact bytes
// are ever compared: hand-written placeholder outputs are honest inputs here — the
// behaviour under test is the boot-path LOG, not byte identity.
//
// One compile() harness per FILE (the babel loopback is one per module realm — see
// babelLoopback.ts); the security-rejected-branch twin of this case lives in
// artifactLibraryVariantMissingSecurity.boot.test.ts.

/** A variant-less library zip: sidecar + index with a VALID stamp and no `library`
 *  blocks — the shape of every zip built before the opt-in emission flag exists
 *  (the ordinary world until R3-1345 lands). */
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
  // Never read: a skip decision reads no artifact file. Present so the zip's shape is
  // the real one.
  '.immediately.run/artifacts/transpiled/src/greet.ts.js': '/* never served: no variant */\n',
});

describe('R3-1343 — the library-variant boot line (clean branch)', () => {
  let h: BundlerHarness;
  let unmount: (() => void) | null = null;
  let lines: string[];

  beforeAll(async () => {
    const restoreGlobals = installEvalGlobals();
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      h = await createBundlerHarness(EVAL_FIXTURE, { forCompile: true });
      unmount = await mountInMemoryFs('/mnt/testlib', variantlessLibrary());
      await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/testlib');
      await h.bundler.compile();
      // Capture BEFORE mockRestore — restore clears the mock's call data.
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

  it('says the library module live-transpiled because the zip has no variant', () => {
    const variantLines = lines.filter((l) => l.includes('live-transpiled'));
    expect(variantLines).toHaveLength(1);
    expect(variantLines[0]).toBe('[ir-artifacts] 1 library module(s) live-transpiled: no library variant in the zip');
  });

  it('says it exactly once — one line per boot, default-visible (R3-294)', () => {
    expect(lines.filter((l) => l.startsWith('[ir-artifacts] 1 library module(s)'))).toHaveLength(1);
  });
});
