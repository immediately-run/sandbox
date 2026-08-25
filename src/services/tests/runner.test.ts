// R3-222 Phase 2 — the test engine. What is worth covering is the FAILURE reporting:
// exit (a) is "a failing test reports the failure with enough detail for the agent to
// fix it", and a runner whose message is "assertion failed" satisfies nothing.

import {
  AssertionError,
  createExpect,
  createRegistry,
  deepEqual,
  failureMessage,
  runCollected,
  summarize,
} from './runner';

const fails = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the assertion to fail, but it passed');
};

describe('expect — the assertion surface', () => {
  it('passes the true cases quietly', () => {
    const e = createExpect(2);
    e.toBe(2);
    e.toEqual(2);
    e.toBeTruthy();
    e.toBeGreaterThan(1);
    e.toBeLessThan(3);
    createExpect([1, 2]).toContain(2);
    createExpect('abc').toContain('b');
    createExpect([1, 2]).toHaveLength(2);
    createExpect(null).toBeNull();
    createExpect(undefined).toBeUndefined();
    createExpect(0).toBeDefined();
    createExpect('hello world').toMatch(/world/);
  });

  it('names BOTH values on failure — an agent cannot fix "assertion failed"', () => {
    expect(fails(() => createExpect(2).toBe(3))).toBe('expected 2 to be 3');
    expect(fails(() => createExpect('a').toBe('b'))).toBe('expected "a" to be "b"');
    expect(fails(() => createExpect({ a: 1 }).toEqual({ a: 2 }))).toBe('expected {"a":1} to equal {"a":2}');
    expect(fails(() => createExpect([1]).toHaveLength(3))).toContain('to have length 3 (got 1)');
  });

  it('compares structurally for toEqual and referentially for toBe', () => {
    createExpect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
    expect(fails(() => createExpect({ a: 1 }).toBe({ a: 1 } as unknown))).toContain('to be');
    expect(deepEqual([1, [2]], [1, [2]])).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it('.not flips the verdict and says so in the message', () => {
    createExpect(2).not.toBe(3);
    expect(fails(() => createExpect(2).not.toBe(2))).toBe('expected 2 not to be 2');
  });

  it('toThrow reports what was thrown when it does not match', () => {
    createExpect(() => {
      throw new Error('boom');
    }).toThrow('boom');
    createExpect(() => {
      throw new Error('boom');
    }).toThrow(/bo+m/);
    expect(fails(() => createExpect(() => undefined).toThrow())).toContain('to throw');
    expect(
      fails(() =>
        createExpect(() => {
          throw new Error('boom');
        }).toThrow('bang'),
      ),
    ).toContain('threw "boom"');
  });

  it('refuses a non-function for toThrow instead of silently passing', () => {
    expect(fails(() => createExpect(2).toThrow())).toContain('needs a function');
  });
});

describe('the registry', () => {
  it('nests describe names into the reported test name', async () => {
    const { globals, collected } = createRegistry();
    globals.describe('outer', () => {
      globals.describe('inner', () => {
        globals.it('works', () => {});
      });
    });
    const [r] = await runCollected('a.test.ts', collected);
    expect(r.name).toBe('outer › inner › works');
  });

  it('records skips rather than dropping them — a vanished suite reads like a pass', async () => {
    const { globals, collected } = createRegistry();
    globals.describe.skip('parked', () => {
      globals.it('one', () => {});
      globals.it('two', () => {});
    });
    globals.it.skip('todo');
    const results = await runCollected('a.test.ts', collected);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'skip')).toBe(true);
  });

  it('honours .only by SKIPPING the rest, so the count still adds up', async () => {
    const { globals, collected } = createRegistry();
    globals.it('a', () => {});
    globals.it.only('b', () => {});
    const results = await runCollected('a.test.ts', collected);
    expect(results.find((r) => r.name === 'a')!.status).toBe('skip');
    expect(results.find((r) => r.name === 'b')!.status).toBe('pass');
  });

  it('pops the describe stack even when the body throws', () => {
    const { globals, collected } = createRegistry();
    expect(() =>
      globals.describe('bad', () => {
        throw new Error('registration blew up');
      }),
    ).toThrow('registration blew up');
    globals.it('after', () => {});
    expect(collected[0].name).toBe('after');
  });
});

describe('running — exit (a): a failure carries enough to fix it', () => {
  it('reports pass, fail and the assertion message', async () => {
    const { globals, collected } = createRegistry();
    globals.it('passes', () => globals.expect(1).toBe(1));
    globals.it('fails', () => globals.expect(1).toBe(2));
    const results = await runCollected('src/a.test.ts', collected);
    expect(results[0]).toMatchObject({ file: 'src/a.test.ts', name: 'passes', status: 'pass' });
    expect(results[1].status).toBe('fail');
    expect(results[1].message).toContain('expected 1 to be 2');
  });

  it('awaits an async test, and reports its rejection', async () => {
    const { globals, collected } = createRegistry();
    globals.it('async pass', async () => {
      await Promise.resolve();
      globals.expect(1).toBe(1);
    });
    globals.it('async fail', async () => {
      await Promise.resolve();
      throw new TypeError('cannot read x of undefined');
    });
    const results = await runCollected('a.test.ts', collected);
    expect(results[0].status).toBe('pass');
    expect(results[1].status).toBe('fail');
    // The ERROR TYPE survives — "TypeError: cannot read x" is the fixable message.
    expect(results[1].message).toContain('TypeError: cannot read x of undefined');
  });

  it('one failing test does not stop the rest of the file', async () => {
    const { globals, collected } = createRegistry();
    globals.it('a', () => globals.expect(1).toBe(2));
    globals.it('b', () => globals.expect(1).toBe(1));
    const results = await runCollected('a.test.ts', collected);
    expect(results.map((r) => r.status)).toEqual(['fail', 'pass']);
  });

  it('records a duration from the injected clock', async () => {
    const { globals, collected } = createRegistry();
    globals.it('slow', () => {});
    let t = 0;
    const results = await runCollected('a.test.ts', collected, () => (t += 5));
    expect(results[0].durationMs).toBe(5);
  });

  it('failureMessage keeps a location frame when the error has a stack', () => {
    const e = new AssertionError('expected 1 to be 2');
    e.stack = 'AssertionError: x\n    at myTest (/app/src/a.test.ts:4:11)';
    expect(failureMessage(e)).toContain('/app/src/a.test.ts:4:11');
  });
});

describe('summarize', () => {
  it('counts each status, and keeps `unsupported` separate from `skipped`', () => {
    // A skip is a choice the author made; an unsupported suite is a limit of the realm.
    // Folding them together is how a false green gets built.
    const s = summarize(
      [
        { file: 'a', name: '1', status: 'pass', durationMs: 0 },
        { file: 'a', name: '2', status: 'fail', durationMs: 0 },
        { file: 'a', name: '3', status: 'skip', durationMs: 0 },
      ],
      2,
    );
    expect(s).toEqual({ passed: 1, failed: 1, skipped: 1, unsupported: 2 });
  });
});
