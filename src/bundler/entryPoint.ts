/**
 * What a manifest-declared entry (`package.json` `main`/`source`/`module`) means
 * when the bundler resolves the bundle's entry module (BOOT_SCAFFOLDING_SPEC §4.1).
 *
 * BUNDLE_EMBEDDING_SPEC §4c.1 and `core_concepts` resolve a program's entry as
 * "`package.json` `main`, else `src/App.tsx`" — the component the boot scaffolding
 * dispatches. `resolveEntryPoint` historically took the same `main` as the BUNDLE
 * entry, so a manifest following the spec (`main: src/App.tsx`) evaluated the
 * component as a plain module: the boot-defaults `index.tsx` never ran, `#root`
 * stayed empty, and the host reported the app ready anyway. The rule decided here:
 *
 *  - a declared entry that resolves to a path the boot-defaults entry dispatches
 *    anyway (the program-component candidates below) is skipped — the bundle entry
 *    stays the boot scaffolding `index.tsx`, and the manifest selects the
 *    component it renders;
 *  - a declared entry that calls a render API (`createRoot`/`hydrateRoot`, or the
 *    SDK boot specifier) IS the render entry — a repository that ships its own
 *    keeps working;
 *  - a declared entry that default-exports a component — a capitalized name in a
 *    file that carries JSX tags — and calls no render API can never render;
 *    refused with a diagnostic instead of a blank, ready-reporting frame. The JSX
 *    requirement keeps uppercase-CONSTANT defaults (`export default TITLE`) out of
 *    the refusal: they resolve as before;
 *  - anything else keeps resolving as the entry, as before: a vanilla module with
 *    top-level side effects is outside the component heuristic's reach, and the
 *    heuristic deliberately prefers "runs as before" over a false refusal.
 *
 * Both checks are token walks over the shared scanner skeleton
 * (`utils/sourceScan`) — no AST, cheap in the iframe bundle, and a `createRoot` or
 * an `export` inside a string or a comment is never mistaken for the real thing.
 */
import { underAppRoot } from '../fsLayout';
import { scanSourceTokens, tokenSignificantChar, type SourceToken } from '../utils/sourceScan';

/**
 * The repo-absolute paths the boot-defaults entry dispatches as the program:
 * `boot()` → `MainContent` probes exactly these (the counterpart list is the SDK's
 * `MainContent.tsx` `candidates` — keep the two in step), then renders the first
 * that exists. A manifest entry resolving here is component selection, not the
 * bundle entry.
 */
export const BOOT_DISPATCH_CANDIDATES = [
  '/src/App.tsx',
  '/src/App.ts',
  '/src/App.js',
  '/App.tsx',
  '/App.ts',
  '/App.js',
  '/README.md',
  '/README.mdx',
  '/README.html',
];

/** The boot entry's own module — importing it is a render call (`boot()` follows). */
const BOOT_MODULE_SPECIFIER = '@immediately-run/sdk/boot';

/** The DOM render APIs. `ReactDOM.render` (legacy React ≤17) is not one: the
 *  platform's SDK is React 19 and its boot path is `createRoot`-based. */
const RENDER_APIS = new Set(['createRoot', 'hydrateRoot']);

export type DeclaredEntryVerdict =
  /** Skip the candidate — the boot-defaults entry stays the bundle entry. */
  | 'dispatch'
  /** Use the candidate as the bundle entry (a render entry, or a plain module). */
  | 'entry'
  /** Refuse the candidate loudly — it can never render. */
  | 'refuse';

/**
 * Classify one RESOLVED declared entry. `source` is the module's code, or
 * `undefined` when it could not be read — an unreadable entry keeps the
 * historical behaviour (use it) rather than refusing on no evidence.
 */
export function classifyDeclaredEntry(resolvedPath: string, source: string | undefined): DeclaredEntryVerdict {
  if (BOOT_DISPATCH_CANDIDATES.some((candidate) => resolvedPath === underAppRoot(candidate))) {
    return 'dispatch';
  }
  if (source === undefined) return 'entry';
  if (hasRenderCall(source)) return 'entry';
  if (defaultExportsComponent(source)) return 'refuse';
  return 'entry';
}

/**
 * Whether the module calls a render API: a bare `createRoot`/`hydrateRoot`
 * identifier, or the SDK boot specifier in any string (the `import { boot } from
 * '@immediately-run/sdk/boot'` form — the call site check stays specifier-based
 * because `boot` alone is a common word).
 */
function hasRenderCall(source: string): boolean {
  let found = false;
  scanSourceTokens(source, (token) => {
    if (token.kind === 'ident' && RENDER_APIS.has(token.word)) {
      found = true;
      return false;
    }
    if (token.kind === 'string' && token.raw.includes(BOOT_MODULE_SPECIFIER)) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * Whether the source carries JSX tags — a closing `</` or self-closing `/>`
 * outside strings and comments. Comparisons never produce those pairs; regex
 * literals are not skipped (only the CJS scanner does that) but a regex bearing
 * an unescaped `/>` or `</` is rarer than a component, which is the trade the
 * heuristic is allowed to make.
 */
function hasJsxTags(source: string): boolean {
  let prevPunct = '';
  let found = false;
  scanSourceTokens(source, (token) => {
    if (token.kind === 'punct') {
      if ((token.c === '/' && prevPunct === '<') || (token.c === '>' && prevPunct === '/')) {
        found = true;
        return false;
      }
      prevPunct = token.c;
      return;
    }
    if (token.kind !== 'comment') prevPunct = '';
  });
  return found;
}

const isUpperCase = (c: string): boolean => c >= 'A' && c <= 'Z';

/**
 * Whether the module's `export default` exports a React-style component: a
 * capitalized named function/class, or a capitalized identifier, in a file whose
 * body carries JSX (a constants module's uppercase default is not a component).
 * An anonymous or arrow default is indeterminate and deliberately NOT matched —
 * the heuristic refuses only the clear case, because the refusal blocks a program
 * that today (mis)resolves. Every `export default` in the file is checked, not
 * just the first.
 */
function defaultExportsComponent(source: string): boolean {
  if (!hasJsxTags(source)) return false;
  // Where the walk sits relative to the last seen `export default`:
  //   0 none seen · 1 after `export` · 2 after `export default` · 3 after the
  //   `function`/`class` keyword (looking for its name).
  let state = 0;
  let matched = false;
  const settle = (verdict: boolean): void => {
    if (verdict) matched = true;
    state = 0;
  };
  scanSourceTokens(source, (token: SourceToken) => {
    if (token.kind === 'comment') return;
    const significant = tokenSignificantChar(token);
    if (state === 0) {
      if (token.kind === 'ident' && token.word === 'export' && significant !== '.') state = 1;
    } else if (state === 1) {
      if (token.kind === 'ident' && token.word === 'default') state = 2;
      else state = 0;
    } else if (state === 2) {
      if (token.kind === 'ident') {
        if (token.word === 'function' || token.word === 'class') state = 3;
        else settle(isUpperCase(token.word[0]));
      } else {
        // `export default <expr>` — an arrow, a literal, a member access:
        // indeterminate, not a named component.
        settle(false);
      }
    } else {
      // state 3 — after `function`/`class`: a name token answers; an anonymous
      // form (`(`, `*`, `{`) is not matched. `extends` here is the anonymous
      // class form (`class extends Base`), not a capitalized name.
      if (token.kind === 'ident' && token.word !== 'extends') settle(isUpperCase(token.word[0]));
      else settle(false);
    }
    return matched ? false : undefined;
  });
  return matched;
}
