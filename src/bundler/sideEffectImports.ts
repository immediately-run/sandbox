/**
 * Extract the **side-effect-only** import specifiers from a module's source —
 * `import "x"` / `import 'x'` with NO bindings (no default, named, or namespace
 * import). These are exactly the CSS / polyfill imports a Vite scaffold parks in
 * `src/main.tsx` (e.g. `import './index.css'`).
 *
 * immediately.run renders `src/App.tsx`'s default export and never executes
 * `main.tsx` (DESIGN_TO §1a rule 3 / §6a decision #27), so those side-effect
 * imports are silently dropped and the app renders unstyled — the #1 silent
 * failure. The bundler uses this to pull main.tsx's side-effect imports into the
 * graph WITHOUT evaluating main.tsx's body (the `createRoot().render()` call that
 * would otherwise double-mount). This function is the static, no-execute half of
 * that fix: it returns the side-effect specifiers and excludes everything with a
 * binding (`import App from './App'`) and the render statements themselves.
 *
 * Robust-but-simple: comments are stripped, then `import` immediately followed by
 * a string literal (optional whitespace, no identifier/`{`/`*` in between) is
 * matched. A binding import always has an identifier, `{`, or `*` after `import`,
 * so it can never match. Order is preserved and duplicates removed.
 */
export function sideEffectImports(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, ''); // line comments

  // A boundary (start, newline, `;`, `{`, or `}`) then `import`, optional
  // whitespace, then directly a quoted specifier — i.e. no binding clause.
  const re = /(?:^|[\n;{}])\s*import\s*(['"])([^'"]+)\1/g;

  const specifiers: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutComments)) !== null) {
    const specifier = match[2];
    if (!seen.has(specifier)) {
      seen.add(specifier);
      specifiers.push(specifier);
    }
  }
  return specifiers;
}
