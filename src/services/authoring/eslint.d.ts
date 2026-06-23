// Minimal ambient types for the `eslint` package (it ships no declarations and
// @types/eslint is not a dependency). We only use the programmatic `Linter`
// class's `defineParser` + `verify`; everything else is intentionally omitted.
// The Worker build swaps in `eslint-linter-browserify`, whose `Linter` is the
// same shape (it is the browser build of this class).
declare module 'eslint' {
  export class Linter {
    defineParser(name: string, parser: unknown): void;
    verify(
      code: string,
      config: unknown,
      filename?: string,
    ): { line: number; column: number; ruleId: string | null; severity: number; message: string }[];
  }
}
