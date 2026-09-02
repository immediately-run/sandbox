// Minimal ambient types for the `eslint` package (it ships no declarations and
// @types/eslint is not a dependency). We use only the programmatic `Linter`
// class's `defineParser` + `verify`; everything else is intentionally omitted.
// That surface already has a name — `LinterLike` in `./lint`, the interface both
// lint hosts inject through — so this stub points at it rather than respelling
// it, and the two cannot drift into disagreeing about the same class.
// The Worker build swaps in `eslint-linter-browserify`, whose `Linter` is the
// same shape (it is the browser build of this class).
declare module 'eslint' {
  export const Linter: new () => import('./lint').LinterLike;
}
