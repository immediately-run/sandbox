/**
 * DG-2 / decision #27 (DESIGN_TO_IMMEDIATELY_RUN §1a rule 3): a default Vite
 * scaffold parks its global CSS (and any polyfills) in `src/main.tsx` — the
 * local-dev render shim that immediately.run does **not** execute (the render
 * entry is the URL-selected `src/App.tsx`). Historically that meant a plain
 * `create-vite` repo rendered *unstyled* on the platform: the #1 silent
 * failure.
 *
 * This module lets the host (kernel) harvest the local entry's **side-effect imports**
 * (`import './index.css'`, `import 'some-polyfill'`) and fold the resolved
 * modules into the graph so they're applied — WITHOUT running `main.tsx`'s
 * `createRoot(...).render(...)` call (which would double-render the app).
 *
 * Everything here is framework-free and dependency-injected so it unit-tests
 * without a live bundler/babel worker.
 */
import { underAppRoot } from '../fsLayout';
import { scanSourceTokens, tokenSignificantChar } from '../utils/sourceScan';

/**
 * Local-entry filenames, by Vite/CRA convention, whose side-effect imports the
 * host (kernel) applies even though it never executes them as the render entry.
 * Ordered most-specific first; repo-relative (resolved under `APP_ROOT`).
 */
export const LOCAL_ENTRY_CANDIDATES = ['src/main', 'main'];

/**
 * Extract the module specifiers of **side-effect-only** import statements from
 * JS/TS/JSX source — i.e. `import './x.css'` / `import "polyfill"`, the bare
 * form with no bindings. Default, named, namespace and dynamic imports are
 * deliberately excluded: those carry the local entry's render logic, not its
 * global side effects.
 *
 * A token walk over the shared scanner skeleton (`utils/sourceScan`), so an
 * `import` inside a string or a comment is never mistaken for a statement, and
 * `obj.import` is never mistaken for the keyword.
 */
export function extractSideEffectImports(source: string): string[] {
  const specifiers: string[] = [];
  let prevSignificant = '';
  // Set after the bare `import` keyword: the next non-comment token answers
  // whether it was a side-effect form (a quoted literal) or a binding/dynamic
  // import — in which case the statement is skipped and the literal, if any,
  // arrives later as its own token.
  let afterImportKeyword = false;
  scanSourceTokens(source, (token) => {
    const significant = tokenSignificantChar(token);
    if (token.kind === 'comment') return;
    if (afterImportKeyword) {
      afterImportKeyword = false;
      if (token.kind === 'string' && token.quote !== '`') {
        specifiers.push(token.raw);
      }
    } else if (token.kind === 'ident' && token.word === 'import' && prevSignificant !== '.') {
      afterImportKeyword = true;
    }
    if (significant !== undefined) prevSignificant = significant;
  });
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
