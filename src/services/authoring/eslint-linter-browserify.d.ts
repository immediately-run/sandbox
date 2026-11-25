// Minimal ambient types for `eslint-linter-browserify` (ships no declarations). It
// is the browser build of eslint's programmatic `Linter`; we use only
// flat-config `verify` (ESLint 9: no `defineParser`) — `LinterLike` in `./lint`, the same surface the
// `eslint` stub (`eslint.d.ts`) names.
declare module 'eslint-linter-browserify' {
  export const Linter: new () => import('./lint').LinterLike;
}
