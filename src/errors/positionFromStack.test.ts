import { EvaluationError, positionFromStack } from './positionFromStack';

/**
 * R3-434 — the evaluation-phase position recovery. The shapes pinned here:
 *  - V8 `at fn (URL:line:col)` / `at URL:line:col` (Chrome/Edge — the sandbox
 *    iframe runs these today);
 *  - SpiderMonkey `fn@URL:line:col` (Firefox);
 *  - a REAL stack produced by a real throw (ways_of_working §4: never only
 *    hand-typed literals — the V8 case below derives its input from an actually
 *    thrown Error, so a dialect change in V8's formatter fails this suite
 *    rather than passing by agreement);
 *  - cross-origin and non-module frames are skipped, never guessed from.
 */

const ORIGIN = 'https://immediately.run';

describe('positionFromStack', () => {
  it('V8: takes the first same-origin module frame out of `at fn (url:l:c)`', () => {
    const stack = [
      "ReferenceError: Cannot access 'off' before initialization",
      '    at fn (https://cdn.example.com/vendor.js:10:9)',
      `    at Module.App (https://immediately.run/app/src/App.tsx:41:6)`,
      `    at https://immediately.run/app/src/main.tsx:12:3)`,
    ].join('\n');
    expect(positionFromStack(stack, ORIGIN)).toEqual({ path: '/app/src/App.tsx', line: 41, column: 6 });
  });

  it('V8: bare `at url:l:c` frames (module top level) work too', () => {
    const stack = `Error: boom\n    at ${ORIGIN}/app/src/entry.ts:7:15`;
    expect(positionFromStack(stack, ORIGIN)).toEqual({ path: '/app/src/entry.ts', line: 7, column: 15 });
  });

  it('SpiderMonkey: `fn@url:l:c` frames work', () => {
    const stack = `ReferenceError: off is not defined\nrun@${ORIGIN}/app/src/hooks.ts:9:17\n@${ORIGIN}/app/src/main.tsx:2:1`;
    expect(positionFromStack(stack, ORIGIN)).toEqual({ path: '/app/src/hooks.ts', line: 9, column: 17 });
  });

  it('skips a frame that IS the origin (the top document is not a module)', () => {
    const stack = `Error: x\n    at (${ORIGIN}:1:1)\n    at (${ORIGIN}/app/src/a.ts:3:4)`;
    expect(positionFromStack(stack, ORIGIN)).toEqual({ path: '/app/src/a.ts', line: 3, column: 4 });
  });

  it('returns null when no frame is same-origin (extension/CDN only)', () => {
    const stack = 'Error: x\n    at fn (https://elsewhere.example/x.js:1:1)';
    expect(positionFromStack(stack, ORIGIN)).toBeNull();
  });

  it('returns null on an empty/absent stack, never throws', () => {
    expect(positionFromStack(undefined, ORIGIN)).toBeNull();
    expect(positionFromStack('', ORIGIN)).toBeNull();
    expect(positionFromStack('Error: no frames here', ORIGIN)).toBeNull();
  });

  it('REAL PRODUCER: a stack from an actually-thrown error locates this test file', () => {
    // The real producer of a V8 stack is a throw. Under jest's ESM runner the
    // frames are `file://` URLs whose prefix is this file's directory — assert
    // the parser extracts THIS file's frame with its real position.
    let thrown: Error;
    try {
      throw new Error('real throw');
    } catch (e) {
      thrown = e as Error;
    }
    const filePath = expect.getState().testPath!;
    const withSlash = filePath.replace(/positionFromStack\.test\.ts$/, '');
    const origin = thrown.stack!.includes(`file://${withSlash}`)
      ? `file://${withSlash.slice(0, -1)}`
      : withSlash.slice(0, -1);
    const pos = positionFromStack(thrown.stack, origin);
    expect(pos).not.toBeNull();
    expect(pos!.path.endsWith('positionFromStack.test.ts')).toBe(true);
    expect(pos!.line).toBeGreaterThan(0);
    expect(pos!.column).toBeGreaterThan(0);
  });
});

describe('EvaluationError', () => {
  it('keeps the message verbatim and carries the recovered position', () => {
    const err = new Error("Cannot access 'off' before initialization");
    err.stack = `ReferenceError: Cannot access 'off' before initialization\n    at App (${ORIGIN}/app/src/App.tsx:41:6)`;
    const e = new EvaluationError(err, ORIGIN);
    expect(e.message).toBe("Cannot access 'off' before initialization");
    expect(e.path).toBe('/app/src/App.tsx');
    expect(e.line).toBe(41);
    expect(e.column).toBe(6);
    expect(e.title).toBe('Runtime error');
  });

  it('stays unpositioned (today’s shape) when the stack yields nothing', () => {
    const err = new Error('boom'); // node stack, wrong origin
    const e = new EvaluationError(err, ORIGIN);
    expect(e.message).toBe('boom');
    expect(e.path).toBeUndefined();
    expect(e.line).toBeUndefined();
    expect(e.column).toBeUndefined();
  });
});
