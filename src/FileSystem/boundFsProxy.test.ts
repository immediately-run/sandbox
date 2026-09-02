import { FsMethod, PromisesOf, wrapBoundFs } from './boundFsProxy';

/**
 * `wrapBoundFs` is the shape `withReadOnlyMounts` and `withRaceTolerance` are
 * both built on, and it is layered on itself (the EROFS guard wraps the
 * race-tolerant proxy). These cases pin the three decisions it makes for both:
 * what reaches `wrapMethod`, that `.promises` is wrapped exactly once, and what
 * `promisesOf` answers before and after the app has touched `.promises`.
 */

interface Calls {
  promises: number;
  methods: string[];
}

function harness(fs: Record<PropertyKey, unknown>) {
  const calls: Calls = { promises: 0, methods: [] };
  let lastPromisesOf: PromisesOf | undefined;
  let lastTarget: object | undefined;
  let lastReceiver: unknown;

  const proxy = wrapBoundFs(
    fs,
    (promises) => {
      calls.promises += 1;
      return { wrapped: true, of: promises } as unknown as Record<string, unknown>;
    },
    (prop, fn: FsMethod, target, receiver, promisesOf) => {
      calls.methods.push(prop);
      lastPromisesOf = promisesOf;
      lastTarget = target;
      lastReceiver = receiver;
      return (...args: unknown[]) => ['wrapped', prop, fn.apply(target, args)];
    },
  );

  return {
    calls,
    proxy,
    promisesOf: () => lastPromisesOf!(lastTarget!, lastReceiver),
    receiver: () => lastReceiver,
  };
}

describe('wrapBoundFs', () => {
  it('wraps fs.promises once and keeps that identity', () => {
    const promises = { writeFile: () => undefined };
    const h = harness({ promises });

    const first = h.proxy.promises;
    const second = h.proxy.promises;

    expect(h.calls.promises).toBe(1);
    expect(first).toBe(second);
    expect((first as { of: unknown }).of).toBe(promises);
    // The promises surface is not also offered to the method wrapper.
    expect(h.calls.methods).toEqual([]);
  });

  it('sends string-keyed function properties to the method wrapper', () => {
    const h = harness({ writeFile: (a: number) => a + 1 });

    const result = (h.proxy.writeFile as (a: number) => unknown)(1);

    expect(h.calls.methods).toEqual(['writeFile']);
    expect(result).toEqual(['wrapped', 'writeFile', 2]);
  });

  it('passes non-function properties through untouched', () => {
    const constants = { O_RDONLY: 0 };
    const h = harness({ constants, ready: true });

    expect(h.proxy.constants).toBe(constants);
    expect(h.proxy.ready).toBe(true);
    expect(h.calls.methods).toEqual([]);
    expect(h.calls.promises).toBe(0);
  });

  it('passes symbol-keyed properties through untouched, function or not', () => {
    const key = Symbol('brand');
    const fn = () => 'raw';
    const h = harness({ [key]: fn });

    expect(h.proxy[key]).toBe(fn);
    expect(h.calls.methods).toEqual([]);
  });

  it('treats a non-object `promises` as an ordinary property', () => {
    const h = harness({ promises: 7 });

    expect(h.proxy.promises).toBe(7);
    expect(h.calls.promises).toBe(0);

    const asFn = harness({ promises: () => 'called' });
    expect((asFn.proxy.promises as () => unknown)()).toEqual(['wrapped', 'promises', 'called']);
    expect(asFn.calls.promises).toBe(0);
  });

  it('answers promisesOf with the raw surface until the app touches .promises', () => {
    const promises = { stat: () => undefined };
    const h = harness({ promises, mkdir: () => undefined });

    void h.proxy.mkdir;
    expect(h.promisesOf()).toBe(promises);
    // Asking for it must not create the wrapper behind the app's back.
    expect(h.calls.promises).toBe(0);
  });

  it('answers promisesOf with the memoized proxy once the app has touched .promises', () => {
    const promises = { stat: () => undefined };
    const h = harness({ promises, mkdir: () => undefined });

    void h.proxy.mkdir;
    const wrapped = h.proxy.promises;

    expect(h.promisesOf()).toBe(wrapped);
    expect(h.calls.promises).toBe(1);
  });

  it('hands the method wrapper the proxy as the receiver, so accessors resolve through it', () => {
    const h = harness({ writeFile: () => undefined });

    void h.proxy.writeFile;

    expect(h.receiver()).toBe(h.proxy);
  });
});
