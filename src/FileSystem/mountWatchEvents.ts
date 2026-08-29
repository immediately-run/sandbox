/**
 * R3-409 — remote (server-side) changes delivered to `fs.promises.watch` on a
 * space mount.
 *
 * The finding: a watch loop on a space fired only for the same tab's writes —
 * ZenFS's Port backend is request/response and cannot forward the host's
 * snapshot stream, and core fires registered watchers only for LOCAL
 * mutations. So remote changes were readable fresh but never delivered as
 * events, and every multi-user app shipped a `pollDir` signature loop
 * (O(files) RPCs per tick, a seconds floor on "live").
 *
 * The host now relays each space mount's server-side batches as mount-anchored
 * `fs-change` messages (site-main `exportfs.ts` — scope-filtered so an
 * out-of-grant path stays unnameable, torn down with the port). This module is
 * the receiving half, and it deliberately does NOT reach into core's
 * `@internal` watcher registry: the registry is module-instance state, and a
 * second import path to it can resolve to a different instance (observed
 * under jest; a bundler would dedupe, but the platform should not depend on
 * that). Instead the app-facing fs's `promises.watch` is WRAPPED: core's own
 * iterator (local writes) is pumped alongside this relay (remote changes), and
 * the merged stream is what the app iterates — public API only, identical
 * event shape from both legs.
 *
 * Own-write echo: core fires local events for the frame's own writes; the host
 * suppresses relays for writes still pending acknowledgement, so a frame is
 * not double-notified for its own echo (documented in FILESYSTEM_SPEC §2.2).
 */

import type { MountChange } from '../protocol/fsChange';

/** One delivered watch event (Node's shape: a type + a filename relative to
 *  the watched path). */
export interface WatchEvent {
  eventType: 'change' | 'rename';
  filename: string;
}

type RelayListener = (mountPath: string, change: MountChange) => void;

/**
 * The frame's mount-change bus. `emit` is fed by the `fs-change` handler
 * (index.ts); `subscribe` is consumed by the wrapped `fs.promises.watch`.
 * Deliberately tiny: no persistence, no ordering beyond arrival, one batch's
 * changes emitted in order.
 */
class MountWatchRelay {
  private listeners = new Set<RelayListener>();

  subscribe(listener: RelayListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(mountPath: string, changes: readonly MountChange[]): void {
    if (typeof mountPath !== 'string' || !Array.isArray(changes)) return;
    for (const change of changes) {
      if (typeof change?.path !== 'string' || change.path.length === 0) continue;
      for (const listener of [...this.listeners]) {
        try {
          listener(mountPath, change);
        } catch {
          /* a throwing consumer must not break the batch */
        }
      }
    }
  }
}

/** The frame-global relay (one per sandbox frame — matches one host frame). */
export const mountWatchRelay = new MountWatchRelay();

/** Node `watch` semantics for which changes a watcher on `watchRoot` sees. */
export function relayEventFor(
  watchRoot: string,
  recursive: boolean,
  mountPath: string,
  change: MountChange,
): WatchEvent | null {
  const root = watchRoot.endsWith('/') && watchRoot !== '/' ? watchRoot.slice(0, -1) : watchRoot;
  const full = joinMountPath(mountPath, change.path);
  if (full !== root && !full.startsWith(`${root}/`)) return null;
  if (!recursive) {
    // A non-recursive watch sees its DIRECT children only (and itself).
    const rest = full.slice(root.length + (root === '/' ? 0 : 1));
    if (rest.includes('/')) return null;
  }
  const filename = full.slice(root.length + (root === '/' ? 0 : 1));
  return { eventType: change.kind === 'change' ? 'change' : 'rename', filename };
}

/** Join a mount root and a mount-relative (leading-slash) path defensively
 *  (collapses a doubled separator at the seam; `/`-rooted stays clean). */
export function joinMountPath(mountPath: string, path: string): string {
  const root = mountPath.endsWith('/') && mountPath !== '/' ? mountPath.slice(0, -1) : mountPath;
  const rel = path.startsWith('/') ? path : `/${path}`;
  return root === '/' ? rel : `${root}${rel}`;
}

interface WatchOptions {
  recursive?: boolean;
  [k: string]: unknown;
}

/** The core watch's return surface (an async-iterator object with cleanup). */
interface CoreWatchIterator {
  next(): Promise<IteratorResult<WatchEvent, void>>;
  return?: () => Promise<IteratorResult<WatchEvent, void>>;
  [Symbol.asyncIterator](): AsyncIterator<WatchEvent, void>;
}

/**
 * Wrap one `fs.promises` surface's `watch` so remote (relay) changes are
 * merged into the returned iterator alongside core's local events.
 *
 * The merge is BUFFERED on both legs: core's iterator is pumped continuously
 * (its internal queue holds resolvers, not events — an unpulled event would be
 * dropped), and relay events are pushed into the same FIFO, so the consumer
 * sees every event in arrival order regardless of how fast it iterates.
 */
export function watchWithRelay(
  coreWatch: (filename: unknown, options?: WatchOptions) => CoreWatchIterator,
): (filename: unknown, options?: WatchOptions) => CoreWatchIterator {
  return (filename, options) => {
    const target = coreWatch(filename, options);
    const recursive = options?.recursive === true;
    const watchRoot = joinMountPath('/', String(filename));

    const buffer: WatchEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;

    const push = (event: WatchEvent): void => {
      if (done) return;
      buffer.push(event);
      wake?.();
      wake = null;
    };

    // Leg 1 — core's local events, pumped so none are dropped.
    void (async () => {
      try {
        for await (const ev of target) {
          push({ eventType: ev.eventType as 'change' | 'rename', filename: String(ev.filename) });
        }
      } catch {
        /* core watch failed — remote events keep flowing */
      }
    })();

    // Leg 2 — the mount relay (remote changes).
    const stopRelay = mountWatchRelay.subscribe((mountPath, change) => {
      const event = relayEventFor(watchRoot, recursive, mountPath, change);
      if (event) push(event);
    });

    const take = (): Promise<IteratorResult<WatchEvent, void>> => {
      const buffered = buffer.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<WatchEvent, void>>((resolve) => {
        wake = () => {
          const next = buffer.shift();
          if (next) resolve({ value: next, done: false });
          else resolve({ value: undefined, done: true });
        };
      });
    };

    const cleanup = async (): Promise<IteratorResult<WatchEvent, void>> => {
      done = true;
      stopRelay();
      wake?.();
      wake = null;
      try {
        await target.return?.();
      } catch {
        /* already closed */
      }
      return { value: undefined, done: true };
    };

    return {
      next: take,
      return: cleanup,
      throw: cleanup,
      async [Symbol.asyncDispose]() {
        await cleanup();
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
}

/**
 * Wrap the app-facing fs object so its `promises.watch` carries the relay.
 * Outermost of the fs wrappers (outside the EROFS guard and the race-tolerance
 * wrapper): every watch call lands here first.
 */
export function withMountWatchRelay<T extends object>(fsObject: T): T {
  let promisesProxy: Record<string, unknown> | undefined;
  return new Proxy(fsObject, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'promises' && value && typeof value === 'object') {
        promisesProxy ??= (() => {
          const promises = value as Record<string, unknown>;
          return new Proxy(promises, {
            get(pTarget, pProp, pReceiver) {
              const pValue = Reflect.get(pTarget, pProp, pReceiver);
              if (pProp === 'watch' && typeof pValue === 'function') {
                return watchWithRelay(
                  pValue as unknown as (filename: unknown, options?: WatchOptions) => CoreWatchIterator,
                );
              }
              return pValue;
            },
          });
        })();
        return promisesProxy;
      }
      return value;
    },
  });
}
