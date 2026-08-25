import evaluate from './eval';
// The import.meta shim's runtime half (R3-328). The identifier is a cross-repo contract
// with @immediately-run/transpiler (≥0.8.0, PR #18), whose tests pin the emitted name; this
// side pins the injected value's shape and — the actual bug — that compiled module text
// containing the shimmed reference EVALUATES through the real evaluator with the global.
import { IMPORT_META_GLOBAL, importMetaFor } from './importMeta';

describe('importMetaFor', () => {
  it('exposes exactly the module URL, frozen', () => {
    const meta = importMetaFor('https://sandbox.immediately.run/app/src/a.ts');
    expect(meta.url).toBe('https://sandbox.immediately.run/app/src/a.ts');
    expect(Object.keys(meta)).toEqual(['url']);
    expect(Object.isFrozen(meta)).toBe(true);
  });
});

describe('the evaluator contract', () => {
  it('the identifier matches the transpiler contract (never rename silently)', () => {
    // Mirrors the transpiler's pinned constant — see importMeta.ts for why it is
    // repo-local rather than imported. If either side changes, both tests fail loudly.
    expect(IMPORT_META_GLOBAL).toBe('$ir_import_meta');
  });

  it('shimmed module text evaluates through the real evaluator with the injected global', () => {
    // What the transpiler emits for `module.exports = { url: import.meta.url }` (shape
    // pinned by the transpiler's own tests) — evaluated by THIS repo's real eval(),
    // with the global passed exactly as Evaluation.ts passes it.
    const code = '"use strict";\nmodule.exports = { url: $ir_import_meta.url };';
    const context: any = { id: '/app/src/a.ts', exports: {} };
    const meta = importMetaFor('https://sandbox.immediately.run/app/src/a.ts');
    evaluate(code, () => ({}), context, {}, { [IMPORT_META_GLOBAL]: meta });
    expect(context.exports.url).toBe('https://sandbox.immediately.run/app/src/a.ts');
  });
});
