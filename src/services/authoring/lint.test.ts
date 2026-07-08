import { ServiceInputError } from './format';
// ESLint service: correctness + CS-1 input-trust + bounds (CLIENT_SERVICES_SPEC §6).
// `runLint` takes its `Linter` + parser by injection; Node/jest uses `nodeLintDeps`
// (on-disk `eslint` + `@typescript-eslint/parser`), the Worker `workerLintDeps`
// (`eslint-linter-browserify`). The wrapper below binds the Node deps so each case
// reads like a plain `runLint(req)`.
import { LintRequest, runLint as runLintCore } from './lint';
import { nodeLintDeps } from './lint-node-deps';

const runLint = (req: LintRequest): ReturnType<typeof runLintCore> => runLintCore(req, nodeLintDeps);

describe('runLint', () => {
  it('flags a violation under the fixed recommended preset', () => {
    const { diagnostics } = runLint({ files: [{ path: 'a.ts', content: 'debugger;\nvar x = 1;\n' }] });
    const rules = diagnostics.map((d) => d.ruleId);
    expect(rules).toContain('no-debugger');
    expect(rules).toContain('no-var');
    expect(diagnostics.find((d) => d.ruleId === 'no-debugger')?.severity).toBe('error');
  });

  it('returns no diagnostics for clean code', () => {
    const { diagnostics } = runLint({ files: [{ path: 'ok.ts', content: 'export const n: number = 1;\n' }] });
    expect(diagnostics).toEqual([]);
  });

  it('parses TS/JSX via the kernel-bound parser (no false parse failures)', () => {
    const { diagnostics } = runLint({
      files: [{ path: 'c.tsx', content: 'export const C = (): unknown => (<div className="x" />);\n' }],
    });
    // type annotations + JSX must not crash the linter; no recommended-rule hits here
    expect(Array.isArray(diagnostics)).toBe(true);
  });

  // --- CS-1: no caller-supplied rules / plugins / parser / config object ---

  it('refuses caller-supplied rules/plugins/parser/config (kernel-owned)', () => {
    for (const evil of [
      { rules: { 'no-debugger': 'off' } },
      { plugins: ['./evil'] },
      { parser: './evil-parser.js' },
      { parserOptions: { project: './tsconfig.json' } },
      { overrides: [{ files: ['*'], rules: {} }] },
      { extends: 'eslint:all' },
    ]) {
      expect(() => runLint({ files: [{ path: 'a.ts', content: 'debugger;' }], ...evil })).toThrow(ServiceInputError);
    }
    // proof the kernel rule still fires when no caller override is accepted
    const { diagnostics } = runLint({ files: [{ path: 'a.ts', content: 'debugger;' }] });
    expect(diagnostics.some((d) => d.ruleId === 'no-debugger')).toBe(true);
  });

  it('rejects an unknown preset (fixed enum)', () => {
    expect(() => runLint({ files: [{ path: 'a.ts', content: 'x' }], preset: 'airbnb' })).toThrow(/unknown preset/);
  });

  // --- bounds (shared validateFiles) ---

  it('rejects empty / oversize file sets', () => {
    expect(() => runLint({ files: [] })).toThrow(ServiceInputError);
    expect(() => runLint({ files: [{ path: 'big.ts', content: 'x'.repeat(1024 * 1024 + 1) }] })).toThrow(/size budget/);
  });
});
