import type { Bundler } from '../bundler';
import { HotContext } from './hot';
import type { Module } from './Module';

/**
 * `HotContext.accept`/`decline` are the `module.hot.*` API an app's HMR code
 * calls. Both mark OTHER modules by name, and the marking step is shared, so
 * these cases pin what the shared step must keep: one resolution per name,
 * resolved against the calling module's own file; the mark landing on the
 * RESOLVED module rather than the caller; and a name that resolves to nothing
 * being skipped instead of throwing into the app.
 */

interface Harness {
  bundler: Bundler;
  resolveAsync: jest.Mock;
  /** Register a module the graph knows about, under its resolved path. */
  add(resolvedPath: string): Module;
  make(filepath: string): Module;
}

function harness(): Harness {
  const known = new Map<string, Module>();
  const resolveAsync = jest.fn(async (specifier: string, _from: string) => `/resolved${specifier}`);
  const bundler = {
    enableHMR: jest.fn(),
    resolveAsync,
    getModule: (path: string) => known.get(path),
  } as unknown as Bundler;

  const make = (filepath: string): Module => {
    const module = { filepath, bundler, resetCompilation: jest.fn() } as unknown as Module;
    (module as { hot: HotContext }).hot = new HotContext(module);
    return module;
  };

  return {
    bundler,
    resolveAsync,
    make,
    add(resolvedPath: string) {
      const module = make(resolvedPath);
      known.set(resolvedPath, module);
      return module;
    },
  };
}

/** Resolution is async and the `module.hot.*` call is not: let the marks land. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('HotContext.accept', () => {
  it('marks the resolved module accepted and hangs the callback on it', async () => {
    const h = harness();
    const caller = h.make('/app/index.js');
    const dep = h.add('/resolved./dep');
    const cb = jest.fn();

    caller.hot.accept('./dep', cb);
    await settle();

    expect(h.resolveAsync).toHaveBeenCalledWith('./dep', '/app/index.js');
    expect(dep.hot.hmrConfig?.type).toBe('accept');
    dep.hot.hmrConfig?.callAcceptCallback();
    expect(cb).toHaveBeenCalledTimes(1);
    // The caller marks its dependency, not itself.
    expect(caller.hot.hmrConfig).toBeNull();
  });

  it('resolves every name of an array independently', async () => {
    const h = harness();
    const caller = h.make('/app/index.js');
    const a = h.add('/resolved./a');
    const b = h.add('/resolved./b');

    caller.hot.accept(['./a', './b'], jest.fn());
    await settle();

    expect(h.resolveAsync).toHaveBeenCalledTimes(2);
    expect(a.hot.hmrConfig?.type).toBe('accept');
    expect(b.hot.hmrConfig?.type).toBe('accept');
  });

  it('skips a name the graph has no module for', async () => {
    const h = harness();
    const caller = h.make('/app/index.js');

    caller.hot.accept('./absent', jest.fn());
    await settle();

    expect(caller.hot.hmrConfig).toBeNull();
  });

  it('self-accepts when no path is given', () => {
    const h = harness();
    const caller = h.make('/app/index.js');

    (caller.hot.accept as (p?: string) => void)(undefined);

    expect(caller.hot.hmrConfig?.type).toBe('accept');
    expect(caller.hot.hmrConfig?.selfAccepted).toBe(true);
  });
});

describe('HotContext.decline', () => {
  it('marks the resolved module declined and resets ITS compilation', async () => {
    const h = harness();
    const caller = h.make('/app/index.js');
    const dep = h.add('/resolved./dep');

    caller.hot.decline('./dep');
    await settle();

    expect(dep.hot.hmrConfig?.type).toBe('decline');
    expect(dep.resetCompilation).toHaveBeenCalledTimes(1);
    expect(caller.resetCompilation).not.toHaveBeenCalled();
    expect(caller.hot.hmrConfig).toBeNull();
  });

  it('declines every name of an array', async () => {
    const h = harness();
    const caller = h.make('/app/index.js');
    const a = h.add('/resolved./a');
    const b = h.add('/resolved./b');

    caller.hot.decline(['./a', './b']);
    await settle();

    expect(a.hot.hmrConfig?.type).toBe('decline');
    expect(b.hot.hmrConfig?.type).toBe('decline');
    expect(a.resetCompilation).toHaveBeenCalledTimes(1);
    expect(b.resetCompilation).toHaveBeenCalledTimes(1);
  });

  it('skips a name the graph has no module for', async () => {
    const h = harness();
    const caller = h.make('/app/index.js');

    caller.hot.decline('./absent');
    await settle();

    expect(caller.hot.hmrConfig).toBeNull();
    expect(caller.resetCompilation).not.toHaveBeenCalled();
  });

  it('self-declines when no path is given, resetting its own compilation', () => {
    const h = harness();
    const caller = h.make('/app/index.js');

    (caller.hot.decline as (p?: string) => void)(undefined);

    expect(caller.hot.hmrConfig?.type).toBe('decline');
    expect(caller.resetCompilation).toHaveBeenCalledTimes(1);
  });
});
