// The runtime half of the import.meta shim (R3-328).
//
// The sandbox transpiles app source ESM→CommonJS and evaluates it as a classic script,
// where `import.meta` is a parse-time SyntaxError that kills the whole module (caught live
// on the reckoner demo, 2026-08-24). From @immediately-run/transpiler 0.8.0 the transform
// rewrites the syntax to the identifier below; THIS module provides its value per module,
// injected through the evaluator's globals channel (eval.ts).
//
// CONTRACT: the identifier must equal the transpiler's exported IMPORT_META_GLOBAL. It is
// repo-local here (not imported) by the same precedent as the wire-protocol constants
// (protocol/version.ts): the sandbox pins an npm-published transpiler and must not gain a
// hard import that only resolves post-0.8.0. When the dependency reaches ^0.8.0, import it
// from the package instead — and until then, never change this string silently: a rename
// makes every shimmed reference throw ReferenceError at runtime.

export const IMPORT_META_GLOBAL = '$ir_import_meta';

/** The module-meta value: frozen, exposing exactly the module's own URL. */
export function importMetaFor(url: string): { readonly url: string } {
  return Object.freeze({ url });
}
