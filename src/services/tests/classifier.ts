/**
 * Coverage honesty for `run_tests` (roadmap R3-222 exit (c);
 * `plans/in-browser-test-runner/03-engine-and-tool.mdx` D4).
 *
 * THE POINT OF THIS FILE IS TO SAY NO. The realm has no fs, no network, no native
 * modules and no Node built-ins, so a whole class of real test suites simply cannot run
 * here. The failure mode to avoid is not "some tests don't run" — it is a **false
 * pass**: a green result the agent and the user read as "everything passed" when half
 * the suite never executed. `GAP_ANALYSIS §3`'s impossible tier (F8) is explicit that
 * some of these are permanent capability losses, not scoping exercises.
 *
 * So classification is STATIC and runs BEFORE execution: a suite that needs something
 * the realm does not have is reported `unsupported` with the reason, and is never
 * counted as passing.
 *
 * It is deliberately conservative in one direction only: an import it cannot classify
 * is treated as supported and allowed to fail honestly at runtime. Refusing on
 * suspicion would make the runner useless; a runtime failure is at least visible.
 */

/** Why a suite cannot run in the realm. */
export type UnsupportedReason = 'node-runtime' | 'network' | 'native-dep' | 'snapshot-fs' | 'worker-fs';

export interface SuiteVerdict {
  /** `true` when the realm can honestly execute this suite. */
  supported: boolean;
  reason?: UnsupportedReason;
  /** One line the agent can act on — what is missing and why it will never be here. */
  detail?: string;
}

/** Node built-ins whose absence is structural, not a missing polyfill. */
const NODE_BUILTINS = new Set([
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'worker_threads',
  'crypto',
  'http',
  'https',
  'net',
  'tls',
  'dns',
  'zlib',
  'stream',
  'process',
  'module',
  'vm',
  'cluster',
  'readline',
  'perf_hooks',
  'assert',
  'util',
  'buffer',
  'url',
  'querystring',
  'timers',
  'events',
  'inspector',
  'v8',
]);

/** Packages that are native or have a postinstall build step. `add_dependency` is
 *  declare-only and no install runs, so these can never resolve in the sandbox. */
const NATIVE_DEPS = new Set([
  'sharp',
  'canvas',
  'node-gyp',
  'better-sqlite3',
  'sqlite3',
  'bcrypt',
  'esbuild',
  'puppeteer',
  'playwright',
  'jsdom',
  're2',
  'node-sass',
  'sass-embedded',
]);

/** Test harnesses that are Node processes, not libraries the realm can host. */
const NODE_HARNESSES = new Set(['vitest', 'jest', 'node:test', 'mocha', 'ava', 'tap', 'jasmine', 'karma']);

const REASON_DETAIL: Record<UnsupportedReason, string> = {
  'node-runtime':
    'needs a Node runtime (fs / child_process / process / a Node test harness), which the browser realm does not have and will not get',
  network:
    "reaches the network, which the runner denies by design — the realm runs with connect-src 'none' so a test body cannot be an exfiltration channel",
  'native-dep':
    'depends on a native or postinstall-built package; add_dependency is declare-only and no install step runs, so it can never resolve here',
  'snapshot-fs':
    'reads or writes on-disk snapshots, and the realm has no filesystem (revisit if an in-memory snapshot store lands)',
  'worker-fs': 'uses a worker or filesystem handle the realm does not pass in',
};

/** Bare specifier of an import/require, or `null` for a relative/absolute path. */
export function bareSpecifier(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  // Strip `node:` FIRST and then reduce, so `node:fs/promises` and `fs/promises` give
  // the same answer — otherwise the same builtin is named two different ways depending
  // on which spelling the author used.
  const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
  // Scoped package: keep `@scope/name`; otherwise the first segment.
  const parts = bare.split('/');
  return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every module specifier a source file imports (static, dynamic, and `require`). */
export function importsOf(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\bfrom\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]);
  }
  return out;
}

/** Does this source reach the network directly (rather than via an import)? */
const USES_NETWORK = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(/;
/** Does it drive on-disk snapshots? `toMatchInlineSnapshot` is fine — it is in the file. */
const USES_FILE_SNAPSHOT = /\btoMatchSnapshot\s*\(|__snapshots__/;

/**
 * Classify one test file, statically, before anything runs.
 *
 * Order matters: the most structural impossibility wins, so the reason the agent is
 * given is the one it cannot work around rather than the first one matched.
 */
export function classifySuite(source: string): SuiteVerdict {
  const specs = importsOf(source);
  const bare = specs.map(bareSpecifier).filter((s): s is string => s !== null);

  const native = bare.find((s) => NATIVE_DEPS.has(s));
  if (native) return unsupported('native-dep', `imports "${native}", which `);

  const node = bare.find((s) => NODE_BUILTINS.has(s));
  if (node) return unsupported('node-runtime', `imports "${node}", which `);

  const harness = bare.find((s) => NODE_HARNESSES.has(s));
  if (harness) {
    return unsupported(
      'node-runtime',
      `imports the "${harness}" harness, which `,
      // The runner executes the test INTENT (the describe/it/expect tree), not the Node
      // harness — say so, because "unsupported" alone reads as "rewrite everything".
      ' Write the assertions against the globals the runner provides (describe/it/expect) instead.',
    );
  }

  if (USES_FILE_SNAPSHOT.test(source)) return unsupported('snapshot-fs', 'uses on-disk snapshots, which ');
  if (USES_NETWORK.test(source)) return unsupported('network', 'calls the network, which ');

  return { supported: true };
}

function unsupported(reason: UnsupportedReason, prefix: string, suffix = ''): SuiteVerdict {
  return { supported: false, reason, detail: `${prefix}${REASON_DETAIL[reason]}.${suffix}` };
}

/**
 * The `coverageNote` for a whole run: what ran, what did not, and why.
 *
 * This string is the honesty guarantee made legible. A run where everything was skipped
 * must NOT read like a pass, so it says so first and in plain words.
 */
export function coverageNote(ran: readonly string[], skipped: ReadonlyArray<{ file: string; detail: string }>): string {
  const lines: string[] = [];
  if (ran.length === 0 && skipped.length > 0) {
    lines.push(
      `NOTHING RAN. All ${skipped.length} suite(s) are unsupported in the browser test realm — this is NOT a passing result.`,
    );
  } else {
    lines.push(`Ran ${ran.length} suite(s) in the browser test realm.`);
  }
  if (skipped.length) {
    lines.push(`${skipped.length} suite(s) could not run here:`);
    for (const s of skipped) lines.push(`  ${s.file} — ${s.detail}`);
  }
  lines.push(
    'The realm executes the test INTENT (describe/it/expect over your modules) in an opaque-origin, ' +
      'network-denied frame — it is not your Node test harness, so parity is not guaranteed.',
  );
  return lines.join('\n');
}
