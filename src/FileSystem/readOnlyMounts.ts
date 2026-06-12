import { withErrno } from 'kerium';

import { isAbsolute, normalize } from '../utils/path';

export interface ReadOnlyMountsOptions {
  /** Absolute mount prefixes under which writes are rejected (e.g. `/node_modules`). */
  readOnlyPrefixes: string[];
  /** The bound context's working directory, used to resolve relative paths. */
  pwd: string;
}

// Mutating fs methods whose **first** argument is the target path. Excludes
// fd-based mutators (`write`, `ftruncate`, `fchmod`, …): an fd can only exist if
// `open` already passed the guard, so the fd path is covered there.
const WRITE_ARG0 = new Set([
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'rmdir',
  'rm',
  'unlink',
  'truncate',
  'createWriteStream',
  'chmod',
  'chown',
  'lchmod',
  'lchown',
  'utimes',
  'lutimes',
]);

// Mutating methods with **two** path arguments; a write to either side (the
// destination created, the source modified/removed) is rejected.
const WRITE_TWO_PATHS = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']);

// `open`/`openSync` is guarded only when its flags request write access.
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;

function baseMethod(method: string): string {
  return method.endsWith('Sync') ? method.slice(0, -4) : method;
}

function isGuardedMethod(method: string): boolean {
  const base = baseMethod(method);
  return WRITE_ARG0.has(base) || WRITE_TWO_PATHS.has(base) || base === 'open';
}

/** Does an `open` flags argument request any form of write access? */
function flagsIndicateWrite(flags: unknown): boolean {
  if (flags == null) return false; // defaults to 'r' (read-only)
  if (typeof flags === 'number') {
    return (flags & O_WRONLY) !== 0 || (flags & O_RDWR) !== 0 || (flags & (O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  const s = String(flags);
  return s.includes('w') || s.includes('a') || s.includes('+');
}

/** Resolve a raw path argument against `pwd` to an absolute, normalized path. */
function resolvePath(pwd: string, raw: unknown): string {
  const s = String(raw);
  return normalize(isAbsolute(s) ? s : `${pwd}/${s}`);
}

function isUnderReadOnly(prefixes: string[], resolved: string): boolean {
  return prefixes.some((p) => {
    const prefix = p.endsWith('/') ? p.slice(0, -1) : p;
    return resolved === prefix || resolved.startsWith(`${prefix}/`);
  });
}

/** The resolved offending path if this call targets a read-only mount, else undefined. */
function offendingPath(method: string, args: unknown[], opts: ReadOnlyMountsOptions): string | undefined {
  const base = baseMethod(method);
  const check = (raw: unknown): string | undefined => {
    if (raw == null) return undefined;
    const resolved = resolvePath(opts.pwd, raw);
    return isUnderReadOnly(opts.readOnlyPrefixes, resolved) ? resolved : undefined;
  };

  if (WRITE_TWO_PATHS.has(base)) {
    return check(args[0]) ?? check(args[1]);
  }
  if (base === 'open') {
    return flagsIndicateWrite(args[1]) ? check(args[0]) : undefined;
  }
  return check(args[0]);
}

function erofs(method: string, path: string): Error {
  return withErrno('EROFS', `${baseMethod(method)} of '${path}' is not allowed: read-only mount`);
}

/**
 * Wrap a bound `fs` so writes targeting a read-only mount prefix are rejected
 * with `EROFS` — the app-facing hardening for the ZenFS-only mount table
 * (PRETRANSPILED_ARTIFACTS_SPEC §5.7, Gate 0). Retiring the layered union makes
 * `/node_modules` (a COW whose writable side would otherwise accept writes) and
 * `/transpiled` (a tmpfs) reachable through the shared `fs` handed to app code;
 * without this an app could shadow dependency or transpiled code mid-session.
 *
 * Rejection is **explicit and method-level**, not credential/`no_write`-based:
 * a read-only credential silently drops writes and (per the spike) leaks
 * new-file creation. Reads, and writes anywhere outside the prefixes (e.g.
 * `/app`), pass through untouched. Relative paths are resolved against `pwd`, so
 * a `../node_modules/...` escape is caught.
 *
 * The bundler keeps its own unguarded context for seeding `/node_modules`
 * (runtimes, preloaded modules) and `/transpiled`; only the app-facing context
 * is wrapped.
 */
export function withReadOnlyMounts<T extends object>(fs: T, opts: ReadOnlyMountsOptions): T {
  const guardAsync =
    (target: object, orig: (...a: unknown[]) => unknown, method: string) =>
    (...args: unknown[]): unknown => {
      const bad = offendingPath(method, args, opts);
      return bad === undefined ? Reflect.apply(orig, target, args) : Promise.reject(erofs(method, bad));
    };

  const promisesProxy = new Proxy((fs as Record<string, unknown>).promises ?? {}, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig === 'function' && typeof prop === 'string' && isGuardedMethod(prop)) {
        return guardAsync(target, orig as (...a: unknown[]) => unknown, prop);
      }
      return orig;
    },
  });

  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'promises') return promisesProxy;
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function' || typeof prop !== 'string' || !isGuardedMethod(prop)) {
        return orig;
      }
      const fn = orig as (...a: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        const bad = offendingPath(prop, args, opts);
        if (bad === undefined) return Reflect.apply(fn, target, args);
        const error = erofs(prop, bad);
        // Sync methods and the stream factory surface the error synchronously.
        if (prop.endsWith('Sync') || prop === 'createWriteStream') throw error;
        // Callback form: deliver the error to the trailing callback.
        const last = args[args.length - 1];
        if (typeof last === 'function') {
          (last as (e: Error) => void)(error);
          return undefined;
        }
        throw error;
      };
    },
  });
}
