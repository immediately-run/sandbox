// R3-1081 (sandbox#137 round 1): the flat-config move must not change WHICH files the
// authoring lint service lints. Every path shape runs through BOTH injected linters —
// Node `eslint` (jest, `nodeLintDeps`) and `eslint-linter-browserify` (the Worker's) —
// because the two disagree on cwd-relative matching, and only the Worker ships.
import { Linter as BrowserLinter } from 'eslint-linter-browserify';

import { type LintDeps, matchName, runLint } from './lint';
import { nodeLintDeps } from './lint-node-deps';

const browserDeps: LintDeps = { createLinter: () => new BrowserLinter(), tsParser: nodeLintDeps.tsParser };
const LINTERS: [string, LintDeps][] = [
  ['node eslint', nodeLintDeps],
  ['eslint-linter-browserify', browserDeps],
];
const PATHS = [
  'a.ts',
  'c.tsx',
  'a.js',
  'a.mjs',
  'a.cjs',
  'a.jsx',
  '/abs/dir/a.ts',
  '../up/a.ts',
  './rel/a.ts',
  'deep/a/b/c/a.ts',
  '.hidden.ts',
  'Makefile',
];

describe.each(LINTERS)('runLint path coverage (%s)', (_name, deps) => {
  it.each(PATHS)('lints %s — the preset reports, nothing is skipped', (path) => {
    const res = runLint({ files: [{ path, content: 'debugger;\nvar x = 1;\n' }] }, deps);
    const rules = res.diagnostics.map((d) => d.ruleId);
    expect(rules).toEqual(expect.arrayContaining(['no-debugger', 'no-var']));
    expect(res.skipped).toEqual([]);
    expect(res.diagnostics.every((d) => d.path === path)).toBe(true);
  });

  it.each(['C.TSX', 'B.JSX', 'c.tsx', 'b.jsx'])('parses JSX in %s (any extension case)', (path) => {
    const res = runLint({ files: [{ path, content: 'export const a = <div className="x" />;\nvar v = 1;\n' }] }, deps);
    expect(res.diagnostics.map((d) => d.messageText).filter((m) => m.startsWith('Parsing error'))).toEqual([]);
    expect(res.diagnostics.map((d) => d.ruleId)).toContain('no-var');
  });

  it('a caller syntax error is a diagnostic, never a skip', () => {
    const res = runLint({ files: [{ path: 'bad.ts', content: 'const = ;\n' }] }, deps);
    expect(res.skipped).toEqual([]);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0].messageText).toMatch(/^Parsing error:/);
    expect(res.diagnostics[0].severity).toBe('error');
  });

  it('a parser that CRASHES skips the file (parse-error), never a clean bill', () => {
    const crashing = {
      parseForESLint: () => {
        throw new TypeError('boom');
      },
    };
    const res = runLint({ files: [{ path: 'a.ts', content: 'export {};\n' }] }, { ...deps, tsParser: crashing });
    expect(res.skipped).toEqual([{ path: 'a.ts', reason: 'parse-error' }]);
    expect(res.diagnostics).toEqual([]);
    expect(res.truncated).toBe(true);
  });

  it('a crash whose error has an undefined `location` key is still a crash', () => {
    const crashing = {
      parseForESLint: () => {
        throw Object.assign(new Error('boom'), { location: undefined });
      },
    };
    const res = runLint({ files: [{ path: 'a.ts', content: 'export {};\n' }] }, { ...deps, tsParser: crashing });
    expect(res.skipped).toEqual([{ path: 'a.ts', reason: 'parse-error' }]);
  });
});

describe('matchName', () => {
  it('keeps the base name and its extension', () => {
    expect(matchName('/x/y/c.tsx')).toBe('c.tsx');
    expect(matchName('../a.ts')).toBe('a.ts');
    expect(matchName('a.js')).toBe('a.js');
  });
  it('lower-cases an upper-case lintable extension', () => {
    expect(matchName('dir/C.TSX')).toBe('C.tsx');
    expect(matchName('B.Jsx')).toBe('B.jsx');
  });
  it('gives a name with no lintable extension a .ts suffix', () => {
    expect(matchName('Makefile')).toBe('Makefile.ts');
    expect(matchName('dir/notes.txt')).toBe('notes.txt.ts');
  });
  it('never returns an empty or dot-only name', () => {
    expect(matchName('')).toBe('input.ts');
    expect(matchName('/')).toBe('input.ts');
    expect(matchName('a/..')).toBe('input.ts');
  });
});
