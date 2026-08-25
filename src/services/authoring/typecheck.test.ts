// TypeScript typecheck service: correctness + CS-1 input-trust + bounds
// (CLIENT_SERVICES_SPEC §6, LLM_AND_AGENTS §3.2). Uses the default on-disk lib
// host (Node/jest); the Worker injects bundled libs via createBaseHost.
import { runTypecheck } from './typecheck';
import { ServiceInputError } from './format';

describe('runTypecheck', () => {
  it('reports a type error in a bad file', () => {
    const { diagnostics } = runTypecheck({ files: [{ path: 'bad.ts', content: 'const x: number = "a";' }] });
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    const d = diagnostics[0];
    expect(d.path).toBe('bad.ts');
    expect(d.category).toBe('error');
    expect(d.messageText).toMatch(/not assignable/i);
  });

  it('returns no diagnostics for a clean file', () => {
    const { diagnostics } = runTypecheck({
      files: [{ path: 'ok.ts', content: 'export const add = (a: number, b: number): number => a + b;' }],
    });
    expect(diagnostics).toEqual([]);
  });

  it('reports a syntactic error', () => {
    const { diagnostics } = runTypecheck({ files: [{ path: 'syn.ts', content: 'const = ;' }] });
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  // --- CS-1: kernel-owned compilerOptions; no caller tsconfig is honored ---

  it('ignores caller-supplied compilerOptions/tsconfig fields (strict stays on)', () => {
    // A caller trying to relax strictness via extra request fields must have no
    // effect — strict null/implicit-any still flags this.
    const { diagnostics } = runTypecheck({
      files: [{ path: 'a.ts', content: 'function f(x) { return x.y; }' }],
      // these are NOT part of the request contract and must be ignored:
      ...({ compilerOptions: { strict: false, noImplicitAny: false }, extends: './evil' } as object),
    } as Parameters<typeof runTypecheck>[0]);
    // noImplicitAny (from strict) flags the untyped parameter
    expect(diagnostics.some((d) => /implicitly has an 'any' type/i.test(d.messageText))).toBe(true);
  });

  // --- bounds ---

  it('rejects empty / non-array files', () => {
    expect(() => runTypecheck({ files: [] })).toThrow(ServiceInputError);
    expect(() => runTypecheck({ files: 'nope' as unknown })).toThrow(/non-empty array/);
  });

  it('rejects files over the size budget', () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    expect(() => runTypecheck({ files: [{ path: 'big.ts', content: big }] })).toThrow(/size budget/);
  });
});
