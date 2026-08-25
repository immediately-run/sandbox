/**
 * The test engine (roadmap R3-222 Phase 2;
 * `plans/in-browser-test-runner/03-engine-and-tool.mdx`).
 *
 * A `describe`/`it`/`expect` surface small enough to bundle into the execution realm,
 * over modules the kernel's Babel worker already transpiled. It is NOT vitest or jest —
 * those are Node processes with fs, child_process and native resolvers, none of which
 * exist in the sandbox. It runs the test **intent**, and the `coverageNote` says so, so
 * the agent never reads a green result as full-fidelity parity.
 *
 * PURE ON PURPOSE. Nothing here touches `window`, `postMessage`, a worker, or a
 * timer it did not create — the realm entry does the messaging and the bounding. That
 * keeps the engine unit-testable in jest, which is the only way the failure-reporting
 * behaviour (the thing the agent has to act on) gets covered at all.
 */

export type TestStatus = 'pass' | 'fail' | 'skip';

export interface TestResult {
  file: string;
  name: string;
  status: TestStatus;
  message?: string;
  durationMs: number;
}

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  unsupported: number;
}

/** One registered test, with the `describe` names it sits under. */
interface Registered {
  name: string;
  fn: () => void | Promise<void>;
  skip: boolean;
  only: boolean;
}

/** The globals a compiled test module is evaluated against. */
export interface TestGlobals {
  describe: ((name: string, fn: () => void) => void) & { skip: (name: string, fn: () => void) => void };
  it: TestFn;
  test: TestFn;
  expect: (actual: unknown) => Expectation;
}

interface TestFn {
  (name: string, fn: () => void | Promise<void>): void;
  skip: (name: string, fn?: () => void | Promise<void>) => void;
  only: (name: string, fn: () => void | Promise<void>) => void;
}

/** The assertion surface. Deliberately small: the subset a unit test actually uses,
 *  vendored rather than pulled from a Node-bound library. */
export interface Expectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThan(expected: number): void;
  toThrow(expected?: string | RegExp): void;
  toMatch(expected: string | RegExp): void;
  not: Omit<Expectation, 'not'>;
}

/** An assertion that failed. Carries the message the agent reads to fix the test. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

const show = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
};

/** Structural equality over plain data — enough for `toEqual` without a dependency. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Build `expect(actual)`, with `.not` as the same matchers under a flipped verdict. */
export function createExpect(actual: unknown): Expectation {
  const make = (negated: boolean): Expectation => {
    // `failed` is whether the PLAIN (un-negated) assertion did not hold. Under `.not`
    // that verdict is inverted, so the throw condition is `failed !== negated`.
    const assert = (failed: boolean, describeIt: string): void => {
      if (failed === negated) return;
      throw new AssertionError(`expected ${show(actual)} ${negated ? 'not ' : ''}${describeIt}`);
    };
    const self = {
      toBe: (e: unknown) => assert(!Object.is(actual, e), `to be ${show(e)}`),
      toEqual: (e: unknown) => assert(!deepEqual(actual, e), `to equal ${show(e)}`),
      toBeTruthy: () => assert(!actual, 'to be truthy'),
      toBeFalsy: () => assert(!!actual, 'to be falsy'),
      toBeNull: () => assert(actual !== null, 'to be null'),
      toBeUndefined: () => assert(actual !== undefined, 'to be undefined'),
      toBeDefined: () => assert(actual === undefined, 'to be defined'),
      toContain: (e: unknown) => {
        const has = Array.isArray(actual)
          ? actual.some((x) => deepEqual(x, e))
          : typeof actual === 'string'
          ? actual.includes(String(e))
          : false;
        assert(!has, `to contain ${show(e)}`);
      },
      toHaveLength: (n: number) => {
        const len = (actual as { length?: number })?.length;
        assert(len !== n, `to have length ${n} (got ${String(len)})`);
      },
      toBeGreaterThan: (n: number) => assert(!((actual as number) > n), `to be greater than ${n}`),
      toBeLessThan: (n: number) => assert(!((actual as number) < n), `to be less than ${n}`),
      toMatch: (e: string | RegExp) => {
        const s = String(actual);
        const ok = typeof e === 'string' ? s.includes(e) : e.test(s);
        assert(!ok, `to match ${String(e)}`);
      },
      toThrow: (e?: string | RegExp) => {
        if (typeof actual !== 'function') throw new AssertionError('expect(fn).toThrow() needs a function');
        let thrown: unknown;
        let threw = false;
        try {
          (actual as () => unknown)();
        } catch (err) {
          threw = true;
          thrown = err;
        }
        if (!threw) return assert(true, 'to throw');
        if (e === undefined) return assert(false, 'to throw');
        const msg = (thrown as Error)?.message ?? String(thrown);
        const ok = typeof e === 'string' ? msg.includes(e) : e.test(msg);
        assert(!ok, `to throw matching ${String(e)} (threw ${show(msg)})`);
      },
    } as Omit<Expectation, 'not'>;
    return { ...self, not: negated ? (self as Omit<Expectation, 'not'>) : make(true) } as Expectation;
  };
  return make(false);
}

/** A recording registry plus the globals a module is evaluated against. */
export function createRegistry(): { globals: TestGlobals; collected: Registered[] } {
  const collected: Registered[] = [];
  const stack: string[] = [];
  const fullName = (name: string): string => [...stack, name].join(' › ');

  const register = (
    name: string,
    fn: (() => void | Promise<void>) | undefined,
    opts: { skip?: boolean; only?: boolean },
  ): void => {
    collected.push({
      name: fullName(name),
      fn: fn ?? (() => {}),
      skip: opts.skip === true || fn === undefined,
      only: opts.only === true,
    });
  };

  const describe = ((name: string, fn: () => void) => {
    stack.push(name);
    try {
      fn();
    } finally {
      stack.pop();
    }
  }) as TestGlobals['describe'];
  // A skipped describe still REGISTERS its tests, as skips — a suite that silently
  // vanished would be indistinguishable from one that passed.
  describe.skip = (name: string, fn: () => void) => {
    stack.push(name);
    const before = collected.length;
    try {
      fn();
    } finally {
      stack.pop();
    }
    for (let i = before; i < collected.length; i++) collected[i].skip = true;
  };

  const makeIt = (): TestFn => {
    const it = ((name: string, fn: () => void | Promise<void>) => register(name, fn, {})) as TestFn;
    it.skip = (name: string, fn?: () => void | Promise<void>) => register(name, fn, { skip: true });
    it.only = (name: string, fn: () => void | Promise<void>) => register(name, fn, { only: true });
    return it;
  };

  const it = makeIt();
  return { globals: { describe, it, test: it, expect: createExpect }, collected };
}

/** Wall-clock source, injected so the engine is deterministic under test. */
export type Clock = () => number;

/**
 * Run the tests a module registered.
 *
 * Failures carry the assertion message AND the first stack frame, because "expected 2
 * to be 3" without a location is not enough for the agent to fix anything. A thrown
 * non-assertion error is reported as the failure it is, not swallowed.
 */
export async function runCollected(
  file: string,
  collected: Registered[],
  now: Clock = () => Date.now(),
): Promise<TestResult[]> {
  const only = collected.filter((t) => t.only);
  const chosen = only.length ? only : collected;
  const results: TestResult[] = [];
  for (const t of collected) {
    if (t.skip || !chosen.includes(t)) {
      results.push({ file, name: t.name, status: 'skip', durationMs: 0 });
      continue;
    }
    const started = now();
    try {
      await t.fn();
      results.push({ file, name: t.name, status: 'pass', durationMs: now() - started });
    } catch (e) {
      results.push({ file, name: t.name, status: 'fail', message: failureMessage(e), durationMs: now() - started });
    }
  }
  return results;
}

/** The message the agent reads to fix a failing test. */
export function failureMessage(e: unknown): string {
  if (e instanceof AssertionError) return withFrame(e.message, e);
  const err = e as Error;
  const label = err?.name && err.name !== 'Error' ? `${err.name}: ` : '';
  return withFrame(`${label}${err?.message ?? String(e)}`, err);
}

function withFrame(message: string, e: Error | undefined): string {
  const frame = (e?.stack ?? '')
    .split('\n')
    .slice(1)
    .find((l) => l.includes('at ') && !l.includes('runner.ts'));
  return frame ? `${message}\n    ${frame.trim()}` : message;
}

/** Roll results up. `unsupported` is carried separately — it is NOT a skip, because a
 *  skip is a choice the author made and an unsupported suite is a limit of the realm. */
export function summarize(results: readonly TestResult[], unsupported: number): RunSummary {
  return {
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    unsupported,
  };
}
