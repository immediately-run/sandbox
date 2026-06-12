/**
 * DG-2 / decision #27 (DESIGN_TO_IMMEDIATELY_RUN §1a rule 3): a default Vite
 * scaffold parks its global CSS (and any polyfills) in `src/main.tsx` — the
 * local-dev render shim that immediately.run does **not** execute (the render
 * entry is the URL-selected `src/App.tsx`). Historically that meant a plain
 * `create-vite` repo rendered *unstyled* on the platform: the #1 silent
 * failure.
 *
 * This module lets the kernel harvest the local entry's **side-effect imports**
 * (`import './index.css'`, `import 'some-polyfill'`) and fold the resolved
 * modules into the graph so they're applied — WITHOUT running `main.tsx`'s
 * `createRoot(...).render(...)` call (which would double-render the app).
 *
 * Everything here is framework-free and dependency-injected so it unit-tests
 * without a live bundler/babel worker.
 */
import { underAppRoot } from '../fsLayout';

/**
 * Local-entry filenames, by Vite/CRA convention, whose side-effect imports the
 * kernel applies even though it never executes them as the render entry.
 * Ordered most-specific first; repo-relative (resolved under `APP_ROOT`).
 */
export const LOCAL_ENTRY_CANDIDATES = ['src/main', 'main'];

const isIdentStart = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdentPart = (c: string): boolean => isIdentStart(c) || (c >= '0' && c <= '9');

/**
 * Extract the module specifiers of **side-effect-only** import statements from
 * JS/TS/JSX source — i.e. `import './x.css'` / `import "polyfill"`, the bare
 * form with no bindings. Default, named, namespace and dynamic imports are
 * deliberately excluded: those carry the local entry's render logic, not its
 * global side effects.
 *
 * Implemented as a small scanner (rather than a full AST parse) so it stays
 * cheap in the iframe bundle. It correctly skips string literals, template
 * literals and comments so it never mistakes an `import` keyword inside them for
 * a statement, and ignores `obj.import` member access.
 */
export function extractSideEffectImports(source: string): string[] {
  const specifiers: string[] = [];
  const n = source.length;
  let i = 0;
  // Last non-whitespace, non-comment character consumed — used to tell the
  // `import` keyword apart from an `.import` member access.
  let prevSignificant = '';

  const skipStringFrom = (start: number, quote: string): number => {
    let j = start + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === quote) return j + 1;
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = source[i];

    // Line comment
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String / template literal — note: this is a heuristic for template
    // literals (it doesn't descend into `${...}`), which is fine here because we
    // only care about top-level import statements, never expressions.
    if (c === '"' || c === "'" || c === '`') {
      i = skipStringFrom(i, c);
      prevSignificant = c;
      continue;
    }
    // Identifier / keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);

      if (word === 'import' && prevSignificant !== '.') {
        // Skip whitespace and comments after the keyword to find the next token.
        let k = j;
        while (k < n) {
          const ck = source[k];
          if (ck === ' ' || ck === '\t' || ck === '\r' || ck === '\n') {
            k++;
          } else if (ck === '/' && source[k + 1] === '/') {
            k += 2;
            while (k < n && source[k] !== '\n') k++;
          } else if (ck === '/' && source[k + 1] === '*') {
            k += 2;
            while (k < n && !(source[k] === '*' && source[k + 1] === '/')) k++;
            k += 2;
          } else {
            break;
          }
        }
        const next = source[k];
        if (next === '"' || next === "'") {
          // `import <string>` — a side-effect import. Read the literal.
          const end = skipStringFrom(k, next);
          specifiers.push(source.slice(k + 1, end - 1));
          prevSignificant = next;
          i = end;
          continue;
        }
        // Anything else (`{`, `*`, an identifier, `(` for dynamic import,
        // `type`) is a binding/dynamic import — not a side effect. Resume after
        // the keyword.
      }

      prevSignificant = word[word.length - 1];
      i = j;
      continue;
    }

    if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') {
      prevSignificant = c;
    }
    i++;
  }

  return specifiers;
}

export interface LocalEntrySideEffects {
  /** The resolved local entry (e.g. `/app/src/main.tsx`), if one was found. */
  localEntry?: string;
  /** Resolved, de-duplicated module paths to fold into the graph & evaluate. */
  sideEffectModules: string[];
}

/**
 * Locate the local entry (`src/main`/`main` by convention) and resolve its
 * side-effect imports to module paths. Pure aside from the injected `resolve`
 * (module resolution) and `readFile`; never throws — a missing local entry,
 * unreadable file, or unresolvable import each degrade to "nothing to apply"
 * (preserving the pre-#27 behaviour rather than failing the compile).
 */
export async function collectLocalEntrySideEffects(opts: {
  /** The resolved render entry (e.g. `/app/src/App.tsx`); never re-pulled. */
  entryPoint: string;
  resolve: (specifier: string, from: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  onWarn?: (message: string, err?: unknown) => void;
}): Promise<LocalEntrySideEffects> {
  const { entryPoint, resolve, readFile, onWarn } = opts;
  const from = underAppRoot('/index.js');

  let localEntry: string | undefined;
  for (const candidate of LOCAL_ENTRY_CANDIDATES) {
    try {
      const resolved = await resolve(`./${candidate}`, from);
      // If the convention file IS the render entry, there is no separate shim
      // to harvest — its imports are already in the graph.
      if (resolved === entryPoint) return { sideEffectModules: [] };
      localEntry = resolved;
      break;
    } catch {
      // Candidate doesn't exist; try the next.
    }
  }
  if (!localEntry) return { sideEffectModules: [] };

  let source: string;
  try {
    source = await readFile(localEntry);
  } catch (err) {
    onWarn?.(`Could not read local entry ${localEntry}`, err);
    return { sideEffectModules: [] };
  }

  const seen = new Set<string>();
  const sideEffectModules: string[] = [];
  for (const specifier of extractSideEffectImports(source)) {
    try {
      const resolved = await resolve(specifier, localEntry);
      if (resolved === entryPoint || seen.has(resolved)) continue;
      seen.add(resolved);
      sideEffectModules.push(resolved);
    } catch (err) {
      onWarn?.(`Side-effect import "${specifier}" in ${localEntry} did not resolve`, err);
    }
  }
  return { localEntry, sideEffectModules };
}
