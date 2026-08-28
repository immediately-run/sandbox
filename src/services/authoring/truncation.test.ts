// R3-384 — the service must not lose diagnostics or whole files silently.
//
// The failure this guards is specific: a caller receiving exactly MAX_DIAGS entries
// could not tell "that was all" from "200 of 1,400", and a lint file that failed to
// parse — or that the cap never reached — reported as CLEAN. A consumer whose contract
// is "a truncated run may never render as a clean bill of health" cannot honour it for
// a truncation it cannot see.
import { runTypecheck } from './typecheck';
import { runLint } from './lint';
import { nodeLintDeps } from './lint-node-deps';

// One error per line, so the count is exactly predictable.
const errLines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `export const e${i}: number = 'nope';`).join('\n') + '\n';

describe('typecheck truncation is reported (R3-384)', () => {
  it('under the cap: not truncated, and total equals what was emitted', () => {
    const r = runTypecheck({ files: [{ path: '/a.ts', content: errLines(5) }] });
    expect(r.diagnostics).toHaveLength(5);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(false);
  });

  it('over the cap: emits 200, reports the real total, and flags truncated', () => {
    const r = runTypecheck({ files: [{ path: '/a.ts', content: errLines(260) }] });
    expect(r.diagnostics).toHaveLength(200);
    // The load-bearing assertion: 200 emitted is distinguishable from 200 existing.
    expect(r.total).toBe(260);
    expect(r.truncated).toBe(true);
  });

  it('a clean file is not truncated and totals zero', () => {
    const r = runTypecheck({ files: [{ path: '/a.ts', content: 'export const ok = 1;\n' }] });
    expect(r).toEqual({ diagnostics: [], total: 0, truncated: false });
  });
});

describe('lint truncation and skips are reported (R3-384)', () => {
  const lint = (files: { path: string; content: string }[]) => runLint({ files }, nodeLintDeps);
  // `no-var` fires once per line; two per line keeps the file short.
  const varLines = (n: number): string =>
    Array.from({ length: n }, (_, i) => `var v${i} = 1; export { v${i} };`).join('\n') + '\n';

  it('under the cap: nothing skipped, nothing truncated', () => {
    const r = lint([{ path: '/a.ts', content: varLines(3) }]);
    expect(r.diagnostics.length).toBe(3);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.skipped).toEqual([]);
  });

  it('a file the cap never reached is REPORTED, not silently unchecked', () => {
    const r = lint([
      { path: '/big.ts', content: varLines(260) },
      { path: '/never-linted.ts', content: varLines(2) },
      { path: '/also-never.ts', content: varLines(2) },
    ]);
    expect(r.diagnostics).toHaveLength(200);
    expect(r.truncated).toBe(true);
    // Previously both of these vanished and the caller read the run as complete.
    expect(r.skipped).toEqual([
      { path: '/never-linted.ts', reason: 'not-reached' },
      { path: '/also-never.ts', reason: 'not-reached' },
    ]);
  });

  // Recorded because the review that prompted this item got it wrong, and so did the
  // first draft of the work item: an ordinary syntax error is NOT swallowed. ESLint's
  // Linter returns it as a message with `ruleId: null`, so it is already visible.
  // `verify` throwing is a different, rarer thing — the parser itself failing — and
  // THAT is what the catch handles. Asserting the real behaviour here stops the wrong
  // claim being re-derived from the code's shape.
  it('an unparseable file is reported as a diagnostic, not skipped', () => {
    const r = lint([{ path: '/broken.ts', content: 'export const x = (;\n' }]);
    expect(r.skipped).toEqual([]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ path: '/broken.ts', ruleId: null, severity: 'error' })]);
    expect(r.diagnostics[0].messageText).toMatch(/Parsing error/);
  });

  it('a parser that THROWS is reported as skipped, not as clean', () => {
    // Drive the catch directly — the only honest way to test it, since no ordinary
    // source reaches it. One file throws, the next must still be linted.
    const throwOn = (bad: string) => ({
      createLinter: () => {
        const real = nodeLintDeps.createLinter();
        return {
          defineParser: real.defineParser.bind(real),
          verify: (code: string, config: unknown, filename?: string) => {
            if (filename === bad) throw new Error('parser exploded');
            return real.verify(code, config, filename);
          },
        };
      },
      tsParser: nodeLintDeps.tsParser,
    });
    const r = runLint(
      {
        files: [
          { path: '/boom.ts', content: varLines(1) },
          { path: '/fine.ts', content: varLines(1) },
        ],
      },
      throwOn('/boom.ts'),
    );
    expect(r.skipped).toEqual([{ path: '/boom.ts', reason: 'parse-error' }]);
    // The good file is still linted — one bad file does not abort the run.
    expect(r.diagnostics.map((d) => d.path)).toEqual(['/fine.ts']);
    // A skip alone makes the run incomplete, even though no diagnostic was dropped.
    expect(r.truncated).toBe(true);
  });

  it('a clean run says so unambiguously', () => {
    const r = lint([{ path: '/a.ts', content: 'export const ok = 1;\n' }]);
    expect(r).toEqual({ diagnostics: [], total: 0, truncated: false, skipped: [] });
  });
});
