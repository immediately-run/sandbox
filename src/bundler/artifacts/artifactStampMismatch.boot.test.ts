import {
  createBundlerHarness,
  EVAL_FIXTURE,
  installEvalGlobals,
  type BundlerHarness,
} from '../testHarness/bundlerHarness';

// R3-843 — the decision/emitter join for the stamp-mismatch line: a REAL compile()
// over a full-payload zip whose stamp misses, with console.info spied. The line the
// venue drill greps for must fire from the boot path itself, not only from seed()
// called directly (artifactSeeding.test.ts covers the decision; the string is pinned
// in formatStampMismatch's test). In its own file because compile() tests want a
// fresh module registry (the pattern the testHarness suites already follow).

const MISMATCHED_FIXTURE: Record<string, string> = {
  ...EVAL_FIXTURE,
  '.immediately.run/contribute-manifest.json': JSON.stringify({
    schemaVersion: 1,
    entries: [{ path: 'src/answer.ts', sha: 'sha-answer', type: 'blob' }],
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
      '/src/answer.ts': { srcSha: 'sha-answer', out: 'transpiled/src/answer.ts.js', deps: [] },
    },
  }),
  '.immediately.run/artifacts/transpiled/src/answer.ts.js': '/* stale */ exports.x = 1;\n',
};

describe('R3-843 — the stamp-mismatch boot line (the compile-path join)', () => {
  let h: BundlerHarness;
  afterEach(() => h?.teardown());

  it('emits the mismatch reason exactly once, beside the seeded-0 count', async () => {
    const restoreGlobals = installEvalGlobals();
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    let lines: string[];
    try {
      h = await createBundlerHarness(MISMATCHED_FIXTURE, { forCompile: true });
      await h.bundler.compile();
      // Capture BEFORE mockRestore — restore clears the mock's call data.
      lines = spy.mock.calls.map((c) => String(c[0]));
    } finally {
      spy.mockRestore();
      restoreGlobals();
    }
    const mismatchLines = lines.filter((l) => l.includes('toolchain stamp mismatch'));
    expect(mismatchLines).toHaveLength(1);
    expect(mismatchLines[0]).toContain('/app');
    expect(mismatchLines[0]).toContain('0.0.0-OLD');
    expect(mismatchLines[0]).toContain('deadbeef');
    expect(lines.some((l) => String(l).startsWith('[ir-artifacts] seeded 0 '))).toBe(true);
  }, 30000);
});
