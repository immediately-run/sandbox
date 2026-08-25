// Minimal ambient types for `eslint-linter-browserify` (ships no declarations). It
// is the browser build of eslint's programmatic `Linter`; we use only
// `defineParser` + `verify`, the same surface as the `eslint` stub (`eslint.d.ts`).
declare module 'eslint-linter-browserify' {
  export class Linter {
    defineParser(name: string, parser: unknown): void;
    verify(
      code: string,
      config: unknown,
      filename?: string,
    ): { line: number; column: number; ruleId: string | null; severity: number; message: string }[];
  }
}
