/**
 * Lexical skips shared by the bundler's hand-written source scanners:
 * `extractSideEffectImports` (`bundler/sideEffectImports.ts`, harvesting a Vite/CRA
 * local entry's side-effect imports), `scanCjsModule`
 * (`bundler/transforms/raw-cjs/scan.ts`, deciding ESM-vs-CJS and collecting
 * `require()` specifiers), and the token walk below
 * (`scanSourceTokens` — the skeleton the entry-point classifier's render-call and
 * default-export scans walk).
 *
 * All scan characters rather than parse — an AST parse of every dependency is
 * exactly the cost the raw-CJS path exists to avoid — and all must therefore
 * step over the same lexical constructs so an `import` or `require` inside a
 * string or a comment is never mistaken for a statement. Those skips are what
 * lives here: a mishandled escape or an unterminated literal is one bug, not two.
 *
 * What deliberately does NOT live here is any scanner's statement policy, or
 * the regex-literal skip, which only the CJS scanner performs (see its header for
 * why: dependency code in the wild contains regexes that desync a naive string
 * scan; a local entry's side-effect imports precede any such code).
 *
 * Plain string functions — no DOM, worker, or bundler globals — so either side of
 * any worker boundary can import them.
 */

export const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';

export const isIdentPart = (c: string): boolean => isIdentStart(c) || (c >= '0' && c <= '9');

/**
 * Index just past the identifier/keyword starting at `start` (the caller has
 * already checked `isIdentStart(source[start])`).
 */
export function identifierEnd(source: string, start: number): number {
  let j = start + 1;
  while (j < source.length && isIdentPart(source[j])) j++;
  return j;
}

/**
 * Index just past the string or template literal opened by `quote` at `start`.
 * Backslash escapes are honoured; an unterminated literal consumes the rest of
 * the source. Template literals are skipped WHOLE — no descent into `${…}` —
 * because both callers only look for top-level statements, never expressions.
 */
export function skipStringFrom(source: string, start: number, quote: string): number {
  const n = source.length;
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
}

/**
 * If a comment opens at `at`, the index just past it; otherwise -1.
 *
 * A line comment ends ON its newline (not past it), leaving the newline for the
 * caller's whitespace handling. An unterminated block comment consumes the rest
 * of the source.
 */
export function skipCommentFrom(source: string, at: number): number {
  const n = source.length;
  if (source[at] !== '/') return -1;
  if (source[at + 1] === '/') {
    let j = at + 2;
    while (j < n && source[j] !== '\n') j++;
    return j;
  }
  if (source[at + 1] === '*') {
    let j = at + 2;
    while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
    return j + 2;
  }
  return -1;
}

/**
 * From `at`, skip whitespace and comments and return the index of the next
 * significant character (or `source.length`). Used to look at the token AFTER a
 * keyword without letting a comment between the two hide it.
 */
export function nextSignificantIndex(source: string, at: number): number {
  const n = source.length;
  let k = at;
  while (k < n) {
    const c = source[k];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      k++;
      continue;
    }
    const pastComment = skipCommentFrom(source, k);
    if (pastComment < 0) break;
    k = pastComment;
  }
  return k;
}

/** One lexically significant token of a scanned source. Comments, string and
 *  template literals (skipped whole, no `${…}` descent), and identifiers carry
 *  their span so a consumer can slice the source; every other non-whitespace
 *  character arrives one at a time as `punct`. Whitespace is never reported —
 *  neither scanner treats it as significant. */
export type SourceToken =
  | { kind: 'comment'; start: number; end: number }
  | { kind: 'string'; quote: '"' | "'" | '`'; start: number; end: number; raw: string }
  | { kind: 'ident'; word: string; start: number; end: number }
  | { kind: 'punct'; c: string };

/**
 * Walk `source`'s significant tokens in order, handing each to `visit`. Returning
 * `false` from `visit` stops the walk (a found-what-it-was-looking-for exit).
 * This is the shared skeleton of the bundler's source scanners — the statement
 * policies (what a scanner does with an `import` or an `export default`) stay
 * with the scanners; only the lexical skips live here.
 */
export function scanSourceTokens(source: string, visit: (token: SourceToken) => void | false): void {
  const n = source.length;
  let i = 0;
  while (i < n) {
    const pastComment = skipCommentFrom(source, i);
    if (pastComment >= 0) {
      if (visit({ kind: 'comment', start: i, end: pastComment }) === false) return;
      i = pastComment;
      continue;
    }
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipStringFrom(source, i, c);
      if (visit({ kind: 'string', quote: c, start: i, end, raw: source.slice(i + 1, end - 1) }) === false) return;
      i = end;
      continue;
    }
    if (isIdentStart(c)) {
      const j = identifierEnd(source, i);
      if (visit({ kind: 'ident', word: source.slice(i, j), start: i, end: j }) === false) return;
      i = j;
      continue;
    }
    if (visit({ kind: 'punct', c }) === false) return;
    i++;
  }
}

/** The single character a token contributes to "last significant char" tracking
 *  (the `.` test that tells the `import` keyword from an `.import` member access);
 *  a comment contributes nothing. */
export function tokenSignificantChar(token: SourceToken): string | undefined {
  switch (token.kind) {
    case 'comment':
      return undefined;
    case 'ident':
      return token.word[token.word.length - 1];
    case 'string':
      return token.quote;
    case 'punct':
      return token.c;
  }
}
