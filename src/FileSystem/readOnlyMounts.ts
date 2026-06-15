import { withErrno } from 'kerium';

/**
 * R3-48 G0-3 — app-facing EROFS write-guard (PRETRANSPILED_ARTIFACTS_SPEC §5.7 /
 * §9 "mount hardening, Gate 0").
 *
 * Retiring the layered FS union (G0-4) is what first exposes `/node_modules` and
 * `/transpiled` as real, app-reachable mounts on the shared filesystem handed to
 * app code (`globalThis.__sandpackSharedFs`). They MUST be read-only to the app:
 * the bundler owns their contents. `withReadOnlyMounts` wraps that bound `fs`
 * object so any WRITE whose target path falls under a read-only prefix is rejected
 * with `EROFS` — **including new-file/new-dir creation**. A credential/`no_write`
 * based read-only mount would silently DROP writes and LEAK new-path creation,
 * which §5.7 forbids; so we reject the write METHODS by path prefix instead.
 *
 * Reads (and writes anywhere else, e.g. `/app`) pass through untouched. Both the
 * `fs.promises.*` surface and the callback/sync surfaces are guarded — the COW /
 * tmpfs mounts are InMemory, so a synchronous `writeFileSync` under them would
 * otherwise actually succeed.
 */

// Write-side fs methods whose FIRST argument is the destination path.
const DEST_FIRST = new Set<string>([
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'rmdir',
  'rm',
  'unlink',
  'truncate',
  'createWriteStream',
  'copyFile',
  'symlink',
]);

// Write-side fs methods where BOTH the first (source) and second (destination)
// arguments are paths — a move/link mutates the source mount too, so guard either.
const DEST_FIRST_OR_SECOND = new Set<string>(['rename', 'link']);

type Guard = 'first' | 'both' | null;

/** Classify a method (sync variant stripped) as a guarded write, if any. */
function guardFor(method: string): Guard {
  const base = method.endsWith('Sync') ? method.slice(0, -4) : method;
  if (DEST_FIRST.has(base)) return 'first';
  if (DEST_FIRST_OR_SECOND.has(base)) return 'both';
  return null;
}

function underReadOnly(value: unknown, prefixes: string[]): boolean {
  if (typeof value !== 'string') return false;
  return prefixes.some((p) => value === p || value.startsWith(`${p}/`));
}

/** Do this call's path argument(s) target a read-only mount? */
function violates(args: unknown[], guard: Guard, prefixes: string[]): boolean {
  if (guard === 'first') return underReadOnly(args[0], prefixes);
  if (guard === 'both') return underReadOnly(args[0], prefixes) || underReadOnly(args[1], prefixes);
  return false;
}

/** Wrap the `fs.promises` surface: a guarded write under a RO prefix rejects EROFS. */
function wrapPromises(promises: Record<string, unknown>, prefixes: string[]): Record<string, unknown> {
  return new Proxy(promises, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const guard = guardFor(prop);
      if (!guard) return (value as (...a: unknown[]) => unknown).bind(target);
      return (...args: unknown[]) => {
        if (violates(args, guard, prefixes)) return Promise.reject(withErrno('EROFS'));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Record<string, unknown>;
}

/**
 * Wrap a bound `fs` object so writes under `readOnlyPrefixes` fail `EROFS`.
 * `boundFs` is the `bindContext({...}).fs` object handed to app code.
 */
export function withReadOnlyMounts<T extends object>(boundFs: T, readOnlyPrefixes: string[]): T {
  let promisesProxy: Record<string, unknown> | undefined;
  return new Proxy(boundFs, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'promises' && value && typeof value === 'object') {
        promisesProxy ??= wrapPromises(value as Record<string, unknown>, readOnlyPrefixes);
        return promisesProxy;
      }
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const guard = guardFor(prop);
      if (!guard) return (value as (...a: unknown[]) => unknown).bind(target);
      const isSync = prop.endsWith('Sync');
      return (...args: unknown[]) => {
        if (violates(args, guard, readOnlyPrefixes)) {
          const error = withErrno('EROFS');
          if (isSync) throw error;
          // Callback style (`fs.writeFile(path, data, cb)`): surface EROFS on the cb.
          const last = args[args.length - 1];
          if (typeof last === 'function') return (last as (e: unknown) => void)(error);
          throw error;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
