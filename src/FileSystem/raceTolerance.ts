/**
 * R3-408 — race-tolerant semantics for the app-facing fs (the CLIENT half).
 *
 * React StrictMode runs an app's boot effect twice, so two concurrent seed
 * sequences is the NORMAL first run of any app — and every one of them walked
 * into the same three potholes (`EEXIST` for one of two concurrent recursive
 * `mkdir`s, `EEXIST` for two concurrent creates of the same new file, `ENOENT`
 * for a create racing its parent's `mkdir`). Apps answered by single-flighting
 * directory creation and retrying once on EEXIST/ENOENT — a tax every author
 * pays. This wrapper pays it in the platform instead: it wraps the fs object
 * handed to app code (`globalThis.__sandpackSharedFs`, re-exported as the
 * `fs` module) with Node's own concurrent-seeding semantics:
 *
 *  - `mkdir(path, { recursive: true })`: EEXIST on a path that now exists as a
 *    directory is SUCCESS (exactly `node fs.mkdir recursive`; ZenFS core's
 *    recursive walk stats each segment BEFORE creating it, so two concurrent
 *    walks interleave and the loser's segment-create hits the winner's path —
 *    and once the winner's write is server-acknowledged, no backend can tell
 *    that loser from a plain `mkdir` of a pre-existing dir, because the
 *    `recursive` flag does not exist below the core layer).
 *  - `writeFile` / `appendFile` / `open`: one retry on `EEXIST` (the create
 *    leg lost a race — the retry sees the winner's file and writes through,
 *    last-writer-wins) or `ENOENT` (the create raced its parent's in-flight
 *    `mkdir`). Exactly ONE retry: a persistent error (a genuinely missing
 *    parent, a directory at that path) surfaces from the retry, unchanged.
 *
 * The HOST half of R3-408 lives in site-main's FirestoreFS (mkdir persists a
 * dir doc, so "mkdir returned" ⇒ durable everywhere; EEXIST for an IN-FLIGHT
 * creation is a lost race, not a pre-existing path) and narrows the window
 * this wrapper closes the rest of.
 *
 * Scope: mkdir (recursive only), writeFile, appendFile, open — the
 * write-seeding surface the races were observed on — across the three
 * node-style surfaces (`fs.promises.*`, callback style, and the `*Sync`
 * variants). ZenFS's top-level callback functions bypass the `.promises`
 * property (they call the module's promises directly), so the fs-object proxy
 * intercepts them itself. Other methods pass through untouched, and errors
 * other than EEXIST/ENOENT are never retried.
 */

const RETRYABLE = new Set(['EEXIST', 'ENOENT']);
const EEXIST_ONLY = new Set(['EEXIST']);

const isErrno = (e: unknown, codes: Set<string>): boolean =>
  typeof e === 'object' && e !== null && codes.has((e as { code?: string }).code as string);

const isDirMode = (mode: number | undefined): boolean => typeof mode === 'number' && (mode & 0o170000) === 0o040000;

/** Does `stats` describe a directory (Stats.isDirectory or raw mode bits)? */
function statsIsDirectory(stats: unknown): boolean {
  if (typeof stats === 'object' && stats !== null) {
    const s = stats as { isDirectory?: () => boolean; mode?: number };
    if (typeof s.isDirectory === 'function') return s.isDirectory();
    return isDirMode(s.mode);
  }
  return false;
}

/** The recursive-mkdir EEXIST decision: success iff the path is now a dir. */
async function mkdirEexistFallback(
  promises: { stat: (p: unknown) => Promise<unknown> },
  path: unknown,
  original: unknown,
): Promise<unknown> {
  const stats = await promises.stat(path).catch(() => null);
  if (statsIsDirectory(stats)) return undefined;
  throw original;
}

/** Wrap one `fs.promises`-shaped surface with the R3-408 semantics. */
export function wrapPromisesRaceTolerance(promises: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(promises, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;

      if (prop === 'mkdir') {
        return async (path: unknown, options?: { recursive?: boolean }) => {
          try {
            return await fn.call(target, path, options);
          } catch (e) {
            // Only `recursive` is idempotent; a plain mkdir of an existing
            // dir MUST keep its EEXIST (Node's contract).
            if (!options?.recursive || !isErrno(e, EEXIST_ONLY)) throw e;
            return mkdirEexistFallback(target as { stat: (p: unknown) => Promise<unknown> }, path, e);
          }
        };
      }

      if (prop === 'writeFile' || prop === 'appendFile' || prop === 'open') {
        return (...args: unknown[]) => {
          const attempt = fn.apply(target, args);
          if (!(attempt instanceof Promise)) return attempt;
          return attempt.catch((e: unknown) => {
            if (!isErrno(e, RETRYABLE)) throw e;
            // A create race: one identical retry. A persistent error rejects here.
            return fn.apply(target, args);
          });
        };
      }

      return fn.bind(target);
    },
  });
}

const RETRY_METHODS = new Set(['writeFile', 'appendFile', 'open']);

/**
 * Wrap the bound `fs` object handed to app code. `boundFs` is the
 * `bindContext({...}).fs` object; `readOnlyMounts.withReadOnlyMounts` wraps
 * this from OUTSIDE, so an EROFS rejection never reaches — or loops through —
 * this layer.
 */
export function withRaceTolerance<T extends object>(boundFs: T): T {
  let promisesProxy: Record<string, unknown> | undefined;
  return new Proxy(boundFs, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'promises' && value && typeof value === 'object') {
        promisesProxy ??= wrapPromisesRaceTolerance(value as Record<string, unknown>);
        return promisesProxy;
      }
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      const isSync = prop.endsWith('Sync');
      const base = isSync ? prop.slice(0, -4) : prop;

      const promisesOf = (): Record<string, unknown> =>
        promisesProxy ?? (Reflect.get(target, 'promises', receiver) as Record<string, unknown>);

      if (base === 'mkdir') {
        // Callback / promise-less top-level AND the sync variant. The
        // recursive flag rides args[1] in every spelling.
        return (...args: unknown[]) => {
          const options = args[1] as { recursive?: boolean } | undefined;
          const eexistFallback = (original: unknown): Promise<unknown> =>
            mkdirEexistFallback(
              promisesOf() as unknown as { stat: (p: unknown) => Promise<unknown> },
              args[0],
              original,
            );
          if (isSync) {
            try {
              return fn.apply(target, args);
            } catch (e) {
              if (!options?.recursive || !isErrno(e, EEXIST_ONLY)) throw e;
              const statSync = Reflect.get(target, 'statSync', receiver) as ((p: unknown) => unknown) | undefined;
              if (!statSync) throw e;
              let stats: unknown = null;
              try {
                stats = statSync(args[0]);
              } catch {
                throw e;
              }
              if (statsIsDirectory(stats)) return undefined;
              throw e;
            }
          }
          // Callback style: swap the callback BEFORE the first call, so no
          // attempt ever reaches the caller's callback except a final one.
          const last = args[args.length - 1];
          if (typeof last === 'function') {
            const cb = last as (e: unknown, r?: unknown) => void;
            const callArgs = args.slice(0, -1);
            const attempt = (isRetry: boolean): void => {
              fn.apply(target, [
                ...callArgs,
                ((err: unknown, res?: unknown) => {
                  if (err && !isRetry && options?.recursive && isErrno(err, EEXIST_ONLY)) {
                    eexistFallback(err).then(
                      () => cb(null),
                      (e: unknown) => cb(e),
                    );
                    return;
                  }
                  cb(err, res);
                }) as never,
              ]);
            };
            attempt(false);
            return undefined;
          }
          const result = fn.apply(target, args);
          if (result instanceof Promise) {
            return result.catch((e: unknown) => {
              if (!options?.recursive || !isErrno(e, EEXIST_ONLY)) throw e;
              return eexistFallback(e);
            });
          }
          return result;
        };
      }

      if (RETRY_METHODS.has(base)) {
        const retry = (...args: unknown[]): unknown => {
          if (isSync) {
            try {
              return fn.apply(target, args);
            } catch (e) {
              if (!isErrno(e, RETRYABLE)) throw e;
              return fn.apply(target, args);
            }
          }
          // Callback style: swap the callback BEFORE the first call; the
          // wrapped callback retries once, and only a final result ever
          // reaches the caller's callback.
          const last = args[args.length - 1];
          if (typeof last === 'function') {
            const cb = last as (e: unknown, r?: unknown) => void;
            const callArgs = args.slice(0, -1);
            const attempt = (isRetry: boolean): void => {
              fn.apply(target, [
                ...callArgs,
                ((err: unknown, res?: unknown) => {
                  if (err && !isRetry && isErrno(err, RETRYABLE)) {
                    attempt(true);
                    return;
                  }
                  cb(err, res);
                }) as never,
              ]);
            };
            attempt(false);
            return undefined;
          }
          const result = fn.apply(target, args);
          if (result instanceof Promise) {
            return result.catch((e: unknown) => {
              if (!isErrno(e, RETRYABLE)) throw e;
              return fn.apply(target, args);
            });
          }
          return result;
        };
        return retry;
      }

      return fn.bind(target);
    },
  });
}
