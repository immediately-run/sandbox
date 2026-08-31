import { BundlerError } from './BundlerError';

/**
 * R3-434 — locate an EVALUATION-phase error from its own stack.
 *
 * Compile-phase (transform/Babel) errors already reach `show-error` with
 * `path`/`line`/`column` (`CompilationError` reads the Babel error's `loc`).
 * An evaluation error is a plain `Error` whose module was stamped with
 * `//# sourceURL=${location.origin}${filepath}` (`module/Evaluation.ts`), so the
 * position exists — but only inside the stack, and the stack is the error's OWN
 * data, not display text. Extracting it here (sandbox-side, before `show-error`)
 * is what lets the host's diagnostics (`mapShowError`) file the row under its
 * file instead of the "not file-located" group.
 *
 * Only frames on `origin` are considered: the evaluated modules are same-origin
 * URLs by construction, and anything else (an extension, a CDN script a test
 * pulled in) is not a repo path we could name. The FIRST matching frame wins —
 * it is the deepest module frame the error surfaced through.
 */

/** One parsed frame: the module path (repo- or `/node_modules/`-style, leading
 *  slash, no origin) and its 1-based line/column as they appear in the stack. */
export interface StackPosition {
  path: string;
  line: number;
  column: number;
}

const V8_FRAME = /\(([^()]+):(\d+):(\d+)\)\s*$/;
const V8_BARE = /at\s+([^\s()]+):(\d+):(\d+)\s*$/;
const SPIDERMONKEY_FRAME = /@([^\s@]+):(\d+):(\d+)\s*$/;

/**
 * Find the first same-origin module frame in a stack and return its position.
 * `origin` is the frame's URL prefix (`location.origin` in the sandbox; a file
 * URL prefix under jest). Returns `null` when no frame matches — callers keep
 * today's behaviour (unpositioned) in that case.
 */
export function positionFromStack(stack: string | undefined, origin: string): StackPosition | null {
  if (typeof stack !== 'string' || stack.length === 0 || !origin) return null;
  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Try each dialect's tail shape; the URL is whichever group matches.
    const m = V8_FRAME.exec(line) ?? V8_BARE.exec(line) ?? SPIDERMONKEY_FRAME.exec(line);
    if (!m) continue;
    const [, url, lineNo, colNo] = m;
    if (!url.startsWith(origin)) continue;
    const rest = url.slice(origin.length);
    // `rest` must be a module path: leading slash, non-empty. (A URL equal to the
    // origin itself is the top document, not a module.)
    if (!rest.startsWith('/') || rest.length < 2) continue;
    const lineNum = Number(lineNo);
    const colNum = Number(colNo);
    if (!Number.isFinite(lineNum) || !Number.isFinite(colNum) || lineNum < 1 || colNum < 1) continue;
    return { path: rest, line: lineNum, column: colNum };
  }
  return null;
}

/**
 * The evaluation-phase counterpart of `CompilationError`: keeps the original
 * message verbatim (it is what the overlay shows), and carries the position
 * recovered from the stack so `errorMessage()` emits a located `show-error`.
 */
export class EvaluationError extends BundlerError {
  code = 'EVALUATION_ERROR';

  constructor(error: Error, origin: string) {
    super(error.message);

    this.title = 'Runtime error';
    this.message = error.message;
    const pos = positionFromStack(error.stack, origin);
    if (pos) {
      this.path = pos.path;
      this.line = pos.line;
      this.column = pos.column;
    }
  }
}
