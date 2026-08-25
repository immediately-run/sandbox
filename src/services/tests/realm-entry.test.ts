// R3-222 Phases 1–2 — the realm's own behaviour: what it runs, what it refuses to run,
// and what it reports. Driven through `runSeeded` with an injected evaluator, so the
// honesty rules are covered without a browser (the browser half is the live drill).

import { captureConsole, OUTPUT_CAP, runSeeded, selectTestFiles, functionEvaluator } from './realm-entry';

const mod = (path: string, code: string) => ({ path, code });

const PASSING = `describe('math', () => { it('adds', () => { expect(1 + 1).toBe(2); }); });`;
const FAILING = `it('is wrong', () => { expect(1).toBe(2); });`;

describe('selectTestFiles', () => {
  it('picks *.test.* and *.spec.* by default, in every extension the transpiler emits', () => {
    const mods = ['a.test.ts', 'b.spec.tsx', 'c.test.mjs', 'd.ts', 'e.testing.ts'].map((p) => mod(p, ''));
    expect(selectTestFiles(mods).map((m) => m.path)).toEqual(['a.test.ts', 'b.spec.tsx', 'c.test.mjs']);
  });

  it('honours an explicit selection', () => {
    const mods = ['a.test.ts', 'b.test.ts'].map((p) => mod(p, ''));
    expect(selectTestFiles(mods, ['b.test.ts']).map((m) => m.path)).toEqual(['b.test.ts']);
  });
});

describe('exit (a) — a passing suite passes, a failing one reports enough to fix it', () => {
  it('reports a pass', async () => {
    const res = await runSeeded({ modules: [mod('src/math.test.ts', PASSING)] }, functionEvaluator);
    expect(res.summary).toEqual({ passed: 1, failed: 0, skipped: 0, unsupported: 0 });
    expect(res.results[0]).toMatchObject({ file: 'src/math.test.ts', name: 'math › adds', status: 'pass' });
    expect(res.failures).toEqual([]);
  });

  it('reports a failure with the file, the test name, and both values', async () => {
    const res = await runSeeded({ modules: [mod('src/a.test.ts', FAILING)] }, functionEvaluator);
    expect(res.summary.failed).toBe(1);
    expect(res.failures[0]).toMatchObject({ file: 'src/a.test.ts', name: 'is wrong' });
    expect(res.failures[0].message).toContain('expected 1 to be 2');
  });

  it('a module that throws while REGISTERING is a failure, not a silent zero-test pass', async () => {
    // The false-green this whole design exists to prevent: a suite that blew up on
    // import used to look identical to a suite with nothing in it.
    const res = await runSeeded(
      { modules: [mod('src/bad.test.ts', `throw new Error('import blew up');`)] },
      functionEvaluator,
    );
    expect(res.summary.failed).toBe(1);
    expect(res.failures[0].name).toBe('(module evaluation)');
    expect(res.failures[0].message).toContain('import blew up');
  });

  it('runs several files, and one failing file does not stop the others', async () => {
    const res = await runSeeded({ modules: [mod('a.test.ts', FAILING), mod('b.test.ts', PASSING)] }, functionEvaluator);
    expect(res.summary).toMatchObject({ passed: 1, failed: 1 });
  });
});

describe('exit (c) — an unsupported suite is UNSUPPORTED, never a false pass', () => {
  it('does not execute it, does not count it as passing, and says why', async () => {
    const res = await runSeeded(
      { modules: [mod('src/fs.test.ts', `import fs from 'node:fs';\nit('reads', () => {});`)] },
      functionEvaluator,
    );
    expect(res.summary).toEqual({ passed: 0, failed: 0, skipped: 0, unsupported: 1 });
    expect(res.results).toEqual([]);
    expect(res.coverageNote).toContain('NOTHING RAN');
    expect(res.coverageNote).toContain('src/fs.test.ts');
    expect(res.coverageNote).toContain('needs a Node runtime');
  });

  it('a mixed run reports the green part AND the skipped part in the same note', async () => {
    const res = await runSeeded(
      {
        modules: [
          mod('ok.test.ts', PASSING),
          mod('net.test.ts', `it('x', async () => { await fetch('https://e.com'); });`),
        ],
      },
      functionEvaluator,
    );
    expect(res.summary).toMatchObject({ passed: 1, unsupported: 1 });
    // A green summary next to an unsupported suite must not read as "all passed".
    expect(res.coverageNote).toContain('Ran 1 suite(s)');
    expect(res.coverageNote).toContain('1 suite(s) could not run here');
    expect(res.coverageNote).toContain('net.test.ts');
  });

  it("always carries the parity warning — this is not the app's Node harness", async () => {
    const res = await runSeeded({ modules: [mod('ok.test.ts', PASSING)] }, functionEvaluator);
    expect(res.coverageNote).toContain('not your Node test harness');
  });
});

/* eslint-disable no-console -- this suite's SUBJECT is console capture: it has to call
   the real console to prove the shim intercepts it and then puts it back. */
describe('captured output is bounded — a test cannot make the log the payload', () => {
  it('captures console.* and restores the real console afterwards', async () => {
    const before = console.log;
    const { output } = await captureConsole(async () => {
      console.log('hello', { a: 1 });
      console.error('bad');
    });
    expect(output).toContain('[log] hello {"a":1}');
    expect(output).toContain('[error] bad');
    expect(console.log).toBe(before);
  });

  it('caps the output and SAYS it truncated, rather than cutting silently', async () => {
    const { output } = await captureConsole(async () => {
      for (let i = 0; i < 5000; i++) console.log('x'.repeat(200));
    });
    expect(output.length).toBeLessThan(OUTPUT_CAP + 200);
    expect(output).toContain('[output truncated at');
  });

  it('restores the console even when the run throws', async () => {
    const before = console.log;
    await expect(
      captureConsole(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(console.log).toBe(before);
  });

  it("captures a test's own console output into the result", async () => {
    const res = await runSeeded(
      { modules: [mod('a.test.ts', `it('logs', () => { console.log('from the test'); });`)] },
      functionEvaluator,
    );
    expect(res.output).toContain('from the test');
  });
});

/* eslint-enable no-console */

describe('what the realm cannot reach', () => {
  it('the seeded module gets ONLY the runner globals — no fs, no host, no bridge', async () => {
    // Not a proof of the browser boundary (that is the drill); a proof that the
    // evaluation surface itself hands over nothing but describe/it/expect.
    const seen: string[] = [];
    const res = await runSeeded({ modules: [mod('a.test.ts', PASSING)] }, (code, globals) => {
      seen.push(...Object.keys(globals));
      return functionEvaluator(code, globals);
    });
    expect(seen.sort()).toEqual(['describe', 'expect', 'it', 'test']);
    expect(res.summary.passed).toBe(1);
  });
});
