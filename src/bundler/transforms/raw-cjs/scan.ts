/**
 * Lightweight CommonJS scanner for `/node_modules` sources the bundler serves
 * WITHOUT Babel (see {@link ../raw-cjs RawCjsTransformer}). The Sandpack CDN only
 * returns each package's dependency graph — it never transforms code — and a
 * published npm package is browser-ready JS. So a dependency must NOT go through
 * the Babel chain (preset-env's `useBuiltIns:'usage'` would inject core-js into,
 * and lower, every dependency — the multi-second first-load tax). Babel is for
 * app source only.
 *
 * To pass a dependency through untouched the bundler needs two facts, and this
 * scanner answers both without a parse:
 *
 *   1. Is the file ESM? `import`/`export` *statements* cannot run in the CJS
 *      require-runtime, so an ESM file still has to take the Babel ESM→CJS path.
 *      `import(...)` (dynamic) and `import.meta` are expressions, not statements,
 *      and stay CJS-compatible — they do NOT count as ESM here.
 *   2. What does it `require()`? The module graph is built from
 *      `require(<string literal>)` calls — matching the (require-only) semantics
 *      of the Babel dep-collector this path replaces for CJS modules.
 *
 * Implemented as a string/comment/**regex**-aware character scanner (the same shape
 * as `extractSideEffectImports`) so a `require(` inside a string or comment is never
 * mistaken for a call, and `foo.require(...)` member access is ignored. Regex literals
 * are skipped wholesale too — otherwise a regex body containing a quote or `/`
 * (e.g. `id.replace(/["\\]/g, "\\$&")` in the SDK's `scrollToId.js`) desyncs the string
 * scanner and hides the real `export`/`import` statement after it, misclassifying an ESM
 * module as CJS → served raw → `Unexpected token 'export'` at eval (R3-233).
 */

export interface CjsScan {
  /** `require(<literal>)` specifiers, de-duplicated, first-seen order. */
  requires: string[];
  /** True if the file uses ESM `import`/`export` *statements*. */
  isEsm: boolean;
}

const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdentPart = (c: string): boolean => isIdentStart(c) || (c >= '0' && c <= '9');

// A `/` begins a regex literal (not a division operator) when the previous
// significant token cannot end an expression. Division follows a value —
// an identifier char, `)`, or `]`. Everything else (operators, `(`, `,`, `=`,
// `{`, `;`, start-of-file, …) precedes a regex. The one exception the single-char
// `prevSignificant` can't see: a keyword that reads like an identifier but is
// followed by an expression (`return /re/`, `typeof /re/`), so those are checked
// against the previous WORD.
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'yield', 'await', 'case', 'throw',
]);

export function scanCjsModule(source: string): CjsScan {
  const requires: string[] = [];
  const seen = new Set<string>();
  let isEsm = false;

  const n = source.length;
  let i = 0;
  // Last non-whitespace, non-comment character consumed — tells the `require`
  // identifier apart from a `.require` member access, and the `import`/`export`
  // keyword apart from `.import`/`.export`.
  let prevSignificant = '';
  // Last identifier/keyword consumed (reset by any non-word significant char), so
  // the regex-vs-division heuristic can recognise `return /re/` etc. (see below).
  let prevWord = '';

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

  // Skip a regex literal starting at the opening `/`. Handles `\` escapes and
  // `[...]` character classes (a `/` inside a class does NOT close the regex).
  // A regex cannot span a raw newline; if we reach one unterminated, it was NOT a
  // regex — return `start + 1` so the caller falls back to treating `/` as an
  // operator (safe: it just advances one char).
  const skipRegexFrom = (start: number): number => {
    let j = start + 1;
    let inClass = false;
    while (j < n) {
      const ch = source[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '\n') return start + 1;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        j++;
        break;
      }
      j++;
    }
    // Consume flags (`g`, `i`, …).
    while (j < n && isIdentPart(source[j])) j++;
    return j;
  };

  // From `at`, skip whitespace + comments and return the next significant index.
  const nextSignificant = (at: number): number => {
    let k = at;
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
    return k;
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
    // Regex literal — a `/` that isn't `//`/`/*` (handled above) and sits where an
    // expression is expected. Skip it wholesale so its body (which may contain
    // quotes or `/`) never desyncs the string/statement scan. Division (`a / b`)
    // follows a value — identifier char, `)`, or `]` — and is left as an operator;
    // keyword-preceded expressions (`return /re/`) are caught via `prevWord`.
    if (c === '/') {
      const prevEndsExpr =
        /[A-Za-z0-9_$)\]]/.test(prevSignificant) && !KEYWORDS_BEFORE_REGEX.has(prevWord);
      if (!prevEndsExpr) {
        i = skipRegexFrom(i);
        // A regex literal is a complete value; a following `/` is division.
        prevSignificant = ')';
        prevWord = '';
        continue;
      }
      // else: division operator — fall through to the generic significant-char path.
    }
    // String / template literal — skip wholesale (no `${...}` descent: we only
    // care about top-level statements, never interpolated expressions).
    if (c === '"' || c === "'" || c === '`') {
      i = skipStringFrom(i, c);
      prevSignificant = c;
      prevWord = '';
      continue;
    }
    // Identifier / keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      const memberAccess = prevSignificant === '.';

      if (!memberAccess && (word === 'import' || word === 'export')) {
        const k = nextSignificant(j);
        const after = source[k];
        // `import(` (dynamic) and `import.meta` are expressions, not ESM
        // statements. Anything else after the keyword (a binding, `{`, `*`, `'`,
        // `"`, `default`, `from`, …) marks a real ESM statement.
        if (!(word === 'import' && (after === '(' || after === '.'))) {
          isEsm = true;
        }
      } else if (!memberAccess && word === 'require') {
        const k = nextSignificant(j);
        if (source[k] === '(') {
          const m = nextSignificant(k + 1);
          const q = source[m];
          if (q === '"' || q === "'") {
            const end = skipStringFrom(m, q);
            const specifier = source.slice(m + 1, end - 1);
            if (!seen.has(specifier)) {
              seen.add(specifier);
              requires.push(specifier);
            }
          }
        }
      }

      prevSignificant = word[word.length - 1];
      prevWord = word;
      i = j;
      continue;
    }

    if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') {
      prevSignificant = c;
      prevWord = '';
    }
    i++;
  }

  return { requires, isEsm };
}

/**
 * True when `module.source` at `filepath` is a CommonJS dependency the bundler
 * can pass through untransformed: under `/node_modules`, not an explicit ESM
 * extension (`.mjs`/`.mts`), and free of ESM `import`/`export` statements.
 * `.cjs`/`.cts` are always CJS regardless of body.
 */
export function isPassthroughCjs(filepath: string, source: string): boolean {
  if (!filepath.startsWith('/node_modules/')) return false;
  if (/\.(mjs|mts)$/i.test(filepath)) return false;
  if (/\.(cjs|cts)$/i.test(filepath)) return true;
  return !scanCjsModule(source).isEsm;
}
