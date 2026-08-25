/**
 * The execution-realm bootstrap (roadmap R3-222 Phase 1;
 * `plans/in-browser-test-runner/01-execution-realm.mdx`).
 *
 * This module is the ONLY code that runs at the top of the test realm's document. It
 * waits for the host to seed it with already-transpiled modules, evaluates them against
 * the runner's globals, and posts a structured result back.
 *
 * WHAT IT DELIBERATELY DOES NOT HAVE, and cannot acquire:
 *  - **no fs handle.** The realm is seeded with module SOURCE over `postMessage`; the
 *    agent's `rw` worktree port (AA-23) is never passed in, so a malicious test has
 *    nothing to overwrite.
 *  - **no catalog channel.** There is no bridge to the host's protocol dispatcher, so
 *    `net:fetch`, `secrets:*`, `contribute`, `task:invoke` and `llm:chat` are all
 *    unreachable — not gated, absent.
 *  - **no network.** `connect-src 'none'` on the document (`security/testRealmCsp.ts`).
 *  - **no host DOM, cookies or storage.** The frame is opaque-origin
 *    (`sandbox="allow-scripts"` with no `allow-same-origin`), so it has its own storage
 *    partition and `window.parent` reads give nothing.
 *
 * That is the `TRUST_MODES` executor floor **at its floor**: `resolved = granted ∩
 * stance(mode)` where the realm's ambient set is empty. It is clamped by CONSTRUCTION —
 * the realm is built holding nothing — so there is never anything to strip after the
 * fact (`TRUST_MODES §5` CO-1′/CO-2′).
 *
 * The realm is single-use: the host tears the frame down after each call, so no state
 * leaks between two `run_tests` invocations.
 */

import { classifySuite, coverageNote } from './classifier';
import { createRegistry, runCollected, summarize, type TestResult } from './runner';

/** One already-transpiled module the host seeded. */
export interface SeededModule {
  /** Workspace-relative path, used to label results and to pick out test files. */
  path: string;
  /** Transpiled ESM/CJS source. Compiled by the kernel Babel worker (CS-1 pure
   *  transform — it never executes caller code); the realm only EVALUATES. */
  code: string;
}

export interface RunRequest {
  modules: SeededModule[];
  /** Optional explicit selection; otherwise every `*.test.*`/`*.spec.*` module runs. */
  paths?: string[];
}

export interface RunResponse {
  results: TestResult[];
  failures: Array<{ file: string; name: string; message: string }>;
  summary: ReturnType<typeof summarize>;
  output: string;
  coverageNote: string;
}

/** How much captured `console.*` comes back. Bounded here as well as at the host: the
 *  realm should not be able to flood the channel in the first place. */
export const OUTPUT_CAP = 16 * 1024;

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Which seeded modules are test files? */
export function selectTestFiles(modules: readonly SeededModule[], paths?: readonly string[]): SeededModule[] {
  if (paths?.length) {
    const wanted = new Set(paths);
    return modules.filter((m) => wanted.has(m.path));
  }
  return modules.filter((m) => TEST_FILE.test(m.path));
}

/** Capture `console.*` while `fn` runs, bounded and with an explicit truncation notice.
 *  A runaway `console.log` in a test is common and must not become the payload. */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const real: Partial<Record<(typeof levels)[number], unknown>> = {};
  const c = globalThis.console as unknown as Record<string, (...a: unknown[]) => void>;
  for (const level of levels) {
    real[level] = c[level];
    c[level] = (...args: unknown[]) => {
      if (truncated) return;
      const line = `[${level}] ${args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' ')}`;
      if (bytes + line.length > OUTPUT_CAP) {
        truncated = true;
        lines.push(`[output truncated at ${OUTPUT_CAP} bytes]`);
        return;
      }
      bytes += line.length + 1;
      lines.push(line);
    };
  }
  try {
    const value = await fn();
    return { value, output: lines.join('\n') };
  } finally {
    for (const level of levels) c[level] = real[level] as (...a: unknown[]) => void;
  }
}

function safeString(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Evaluate one compiled test module against the runner's globals.
 *
 * Injected so the realm's evaluation strategy (an inner blob-module import in the
 * browser) can be swapped for a plain `Function` in tests, without either side
 * pretending to be the other.
 */
export type Evaluator = (code: string, globals: Record<string, unknown>) => void | Promise<void>;

/** The default evaluator: a `Function` over the injected globals. Deliberately NOT an
 *  `import()` of a blob URL here — that is the realm document's job, and it needs the
 *  document's CSP (`script-src blob:`) to be in force. */
export const functionEvaluator: Evaluator = (code, globals) => {
  const names = Object.keys(globals);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...names, `"use strict";\n${code}`);
  fn(...names.map((n) => globals[n]));
};

/**
 * Run a seeded request. This is the whole realm behaviour, expressed as a pure-ish
 * function so it is testable in jest without a browser.
 *
 * The honesty rule is enforced here: a suite classified `unsupported` is NOT executed
 * and NOT counted as passing — it is reported, with its reason, in the `coverageNote`.
 */
export async function runSeeded(req: RunRequest, evaluate: Evaluator = functionEvaluator): Promise<RunResponse> {
  const files = selectTestFiles(req.modules, req.paths);
  const ran: string[] = [];
  const skipped: Array<{ file: string; detail: string }> = [];
  const results: TestResult[] = [];

  const { output } = await captureConsole(async () => {
    for (const file of files) {
      const verdict = classifySuite(file.code);
      if (!verdict.supported) {
        skipped.push({ file: file.path, detail: verdict.detail ?? 'unsupported in the browser test realm' });
        continue;
      }
      const { globals, collected } = createRegistry();
      try {
        await evaluate(file.code, globals as unknown as Record<string, unknown>);
      } catch (e) {
        // A module that throws while REGISTERING is a real failure, reported as one —
        // not a silent zero-test pass, which is the false-green this design exists to
        // prevent.
        results.push({
          file: file.path,
          name: '(module evaluation)',
          status: 'fail',
          message: (e as Error)?.message ?? String(e),
          durationMs: 0,
        });
        ran.push(file.path);
        continue;
      }
      results.push(...(await runCollected(file.path, collected)));
      ran.push(file.path);
    }
  });

  return {
    results,
    failures: results
      .filter((r) => r.status === 'fail')
      .map((r) => ({ file: r.file, name: r.name, message: r.message ?? '' })),
    summary: summarize(results, skipped.length),
    output,
    coverageNote: coverageNote(ran, skipped),
  };
}
