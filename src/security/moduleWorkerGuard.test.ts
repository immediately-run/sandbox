// The module-worker fast-fail guard (R3-328). With the import.meta shim, worker URLs into
// the sandbox's virtual module space resolve — and constructing from them must THROW
// SYNCHRONOUSLY (catchable, so app fallbacks engage) instead of hanging on a worker that
// can never load. Non-module URLs pass through natively.
import { MODULE_ROOT, installModuleWorkerGuard, isModuleWorkerUrl } from './moduleWorkerGuard';

const ORIGIN = 'https://sandbox.immediately.run';

describe('isModuleWorkerUrl', () => {
  it('module-space URLs on this origin are module URLs', () => {
    expect(isModuleWorkerUrl(`${ORIGIN}/app/src/entry/engine.ts`, ORIGIN)).toBe(true);
    expect(isModuleWorkerUrl(`${ORIGIN}${MODULE_ROOT}index.js`, ORIGIN)).toBe(true);
  });

  it('same-origin non-module paths, other origins, and relative app paths are not', () => {
    expect(isModuleWorkerUrl(`${ORIGIN}/worker.js`, ORIGIN)).toBe(false); // outside /app/
    expect(isModuleWorkerUrl('https://cdn.example.com/worker.js', ORIGIN)).toBe(false);
    expect(isModuleWorkerUrl('/app/src/w.js', ORIGIN)).toBe(false); // relative — not this origin
  });

  it('relative URLs resolve against the base when one is given', () => {
    expect(isModuleWorkerUrl('/app/src/w.js', ORIGIN, `${ORIGIN}/app/src/index.js`)).toBe(true);
  });

  it('an unparseable URL is left to the native Worker to reject', () => {
    expect(isModuleWorkerUrl('http://[', ORIGIN)).toBe(false);
  });
});

describe('installModuleWorkerGuard', () => {
  function fakeScope() {
    class NativeWorker {
      static stamp = 'native';
      constructedWith: unknown;
      constructor(scriptUrl: unknown, options?: unknown) {
        this.constructedWith = { scriptUrl, options };
      }
    }
    return { Worker: NativeWorker, lastNative: NativeWorker };
  }

  // jest's node env has no `location` — the guard's origin is injected, as in production
  // it comes from the sandbox iframe's own location.
  const install = (scope: any) => installModuleWorkerGuard(scope, ORIGIN);

  it('constructing from a module-space URL throws SYNCHRONOUSLY with the reason', () => {
    const scope: any = fakeScope();
    install(scope);
    expect(() => new scope.Worker(new URL(`${ORIGIN}/app/src/engine.ts`))).toThrow(/sandbox module space/);
    expect(() => new scope.Worker(`${ORIGIN}/app/src/engine.ts`)).toThrow(/hang forever/);
  });

  it('a catchable throw lets an app fall back in-process (the sanctioned pattern)', () => {
    const scope: any = fakeScope();
    install(scope);
    let fellBack = false;
    try {
      new scope.Worker(new URL(`${ORIGIN}/app/src/engine.ts`), { type: 'module' });
    } catch {
      fellBack = true; // the app's catch engages — no hang
    }
    expect(fellBack).toBe(true);
  });

  it('non-module URLs construct through to the native Worker, instanceof intact', () => {
    const scope: any = fakeScope();
    const Native = scope.lastNative;
    install(scope);
    const w: any = new scope.Worker('https://cdn.example.com/worker.js', { type: 'module' });
    expect(w.constructedWith.scriptUrl).toBe('https://cdn.example.com/worker.js');
    expect(w).toBeInstanceOf(Native);
    expect(scope.Worker.stamp).toBe('native'); // statics survive the subclass
  });

  it('is idempotent (double install does not double-wrap)', () => {
    const scope: any = fakeScope();
    install(scope);
    const once = scope.Worker;
    install(scope);
    expect(scope.Worker).toBe(once);
  });
});
