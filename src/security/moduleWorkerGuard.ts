// The module-worker fast-fail guard (R3-328's honest residual).
//
// With the import.meta shim, `new URL('./worker.ts', import.meta.url)` now *resolves* on
// the platform — to a sandbox module-space URL (`https://<sandbox-origin>/app/...`). That
// URL is VIRTUAL: it stands for a file the bundler transpiles on load, not something the
// origin serves as an executable script. A Worker constructed from it fails only via an
// async error event the app never sees as an exception — an app that *constructed* the
// worker successfully would then hang waiting for a message that never comes (exactly the
// reckoner engine's shape: its transport posts `build` and waits).
//
// So the guard makes the impossibility SYNCHRONOUS: constructing a Worker whose script URL
// points into the sandbox module space throws at construction — catchable, so an app-side
// fallback (the sanctioned pattern: `try { new Worker(moduleUrl) } catch { inProcess() }`)
// engages instead of hanging. Workers from any other URL behave natively.

/** The virtual module space's mount prefix (module filepaths are `/app/...`). */
export const MODULE_ROOT = '/app/';

/** True when the URL points into this origin's virtual module space. */
export function isModuleWorkerUrl(rawUrl: string, origin: string, base?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, base);
  } catch {
    return false; // an unparseable URL is the native Worker's error to raise, not ours
  }
  return parsed.origin === origin && parsed.pathname.startsWith(MODULE_ROOT);
}

/**
 * Install the guard on a scope (default: this global). Idempotent; a no-op where no
 * Worker exists. The wrapped class subclasses the native one, so `instanceof` and static
 * members keep working for every URL that is NOT module space. The origin defaults to
 * this frame's (the sandbox iframe IS the module origin); tests inject theirs.
 */
export function installModuleWorkerGuard(scope: any = globalThis, originOverride?: string): void {
  const Native: any = scope.Worker;
  if (typeof Native !== 'function' || Native.__irModuleWorkerGuard) return;

  const origin = originOverride ?? (typeof location !== 'undefined' ? location.origin : '');

  class GuardedWorker extends Native {
    constructor(scriptUrl: string | URL, options?: WorkerOptions) {
      const raw = scriptUrl instanceof URL ? scriptUrl.href : scriptUrl;
      const base = typeof location !== 'undefined' ? location.href : undefined;
      if (isModuleWorkerUrl(raw, origin, base)) {
        throw new Error(
          `immediately.run: cannot construct a Worker from the sandbox module space ("${raw}"). ` +
            `Module URLs are virtual — they are transpiled on load, not served as worker scripts. ` +
            `Catch this error and run the work in-process (or on a host-brokered service) instead; ` +
            `waiting on this worker would hang forever.`,
        );
      }
      super(scriptUrl, options);
    }
  }

  (GuardedWorker as any).__irModuleWorkerGuard = true;
  scope.Worker = GuardedWorker;
}
