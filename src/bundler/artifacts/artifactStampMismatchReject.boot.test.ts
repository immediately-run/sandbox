import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import {
  createBundlerHarness,
  EVAL_FIXTURE,
  installEvalGlobals,
  mountInMemoryFs,
  setDirty,
  type BundlerHarness,
} from '../testHarness/bundlerHarness';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

// R3-843 round 2 — the mutation case for the bundler's logging branch: the defect
// the hoist fixed lived in the bundler, not the store (a stamp-mismatch line inside
// the `else` of the securityReject check goes dark when a coexisting app-root
// rejection takes the `if`). A store-level test cannot see it; this drives the real
// compile() with both conditions live. Own file: one compile() per jest worker is
// the harness's established ceiling (the testHarness suites' pattern).

describe('R3-843 — the mismatch line beside a coexisting securityReject', () => {
  let h: BundlerHarness;
  afterEach(() => h?.teardown());

  it('still emits the mismatch line when the app root security-rejects (the round-2 mutation)', async () => {
    // The defect the hoist fixed lived in the bundler's LOGGING branch, not the
    // store: a stamp-mismatch line inside the `else` of the securityReject check
    // goes dark when a coexisting app-root rejection takes the `if`. This test
    // drives exactly that boot: app root with a VALID stamp but a writable-layer
    // artifact (securityReject), library root with a stale stamp (mismatch) —
    // the library's reason must still log. (Mutation-checked in review: the loop
    // back inside the else fails this test.)
    const fixture: Record<string, string> = {
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
      '.immediately.run/artifacts/transpiled/src/answer.ts.js': '/* app */ exports.x = 1;\n',
    };
    const library: Record<string, string> = {
      'package.json': '{"name":"@scope/lib","version":"1.0.0","main":"src/greet.ts"}',
      'src/greet.ts': 'export const greet = () => "hi";\n',
      '.immediately.run/contribute-manifest.json': JSON.stringify({
        schemaVersion: 1,
        entries: [{ path: 'src/greet.ts', sha: 'sha-greet', type: 'blob' }],
      }),
      '.immediately.run/artifacts/index.json': JSON.stringify({
        schemaVersion: 1,
        toolchain: {
          transpiler: '@immediately-run/transpiler',
          version: '0.0.0-OLD',
          toolchainHash: 'deadbeef'.repeat(8),
          preset: 'react',
        },
        files: {
          '/src/greet.ts': { srcSha: 'sha-greet', out: 'transpiled/src/greet.ts.js', deps: [] },
        },
      }),
      '.immediately.run/artifacts/transpiled/src/greet.ts.js': '/* stale lib */ exports.greet = 0;\n',
    };
    const restoreGlobals = installEvalGlobals();
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let infoLines: string[];
    let warnLines: string[];
    let unmount: (() => void) | null = null;
    try {
      h = await createBundlerHarness(fixture, { forCompile: true });
      unmount = await mountInMemoryFs('/mnt/testlib', library);
      await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/testlib');
      // The app artifact in the writable layer → the app root security-rejects.
      setDirty(h, ['/.immediately.run/artifacts/transpiled/src/answer.ts.js']);
      await h.bundler.compile();
      infoLines = infoSpy.mock.calls.map((c) => String(c[0]));
      warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      unmount?.();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      restoreGlobals();
    }
    expect(warnLines.some((l) => l.includes('Artifact seeding rejected'))).toBe(true);
    const mismatchLines = infoLines.filter((l) => l.includes('toolchain stamp mismatch'));
    expect(mismatchLines).toHaveLength(1);
    expect(mismatchLines[0]).toContain('/node_modules/@scope/lib');
  }, 30000);
});
