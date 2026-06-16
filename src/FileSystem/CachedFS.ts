import { BoundContext } from '@zenfs/core';
import gensync, { Gensync } from 'gensync';

import * as logger from '../utils/logger';
import { Emitter } from '../utils/emitter';

export interface CachedFSChangeEvent {
  path: string;
  eventType: 'rename' | 'change';
}

/** One hydrated file: an `/app`-rooted path + its content (text for source, bytes
 *  for binary payloads like the bundled `/package/` msgpack). */
export interface FsSnapshotEntry {
  path: string;
  content: string | Uint8Array;
}
/** A bulk filesystem snapshot the host pushes at mount so the bundler reads from
 *  memory instead of per-file Port round-trips (R3-49b ZenFS batch hydration). */
export type FsSnapshot = FsSnapshotEntry[];

/**
 * The bundler's filesystem (R3-48 G0-4): a read-memoizing view over a single
 * `@zenfs/core` bound context whose mount table routes `/app` (Port), `/node_modules`
 * (CopyOnWrite over RegistryFS) and `/transpiled` (tmpfs) — replacing the former
 * layered-FS union. Reads under `/node_modules`/`/transpiled` are served by their
 * mounts (never the Port); `/app` reads cross the Port. Successful reads are memoized
 * so repeated reads (e.g. `package.json` lookups during resolution) avoid extra
 * round-trips; the watcher + parent-relayed `markChanged` invalidate. Writes
 * (`registerRuntime`/`addPreloadedModule`/`addLocalModules` → `/node_modules`, and the
 * `/empty.js` stub) write THROUGH to the bound context so subsequent reads see them.
 *
 * Exposes the gensync `readFile`/`isFile` the resolver consumes (async-only; the sync
 * handlers throw, as the bundler always resolves via `resolveAsync`).
 */
export class CachedFS {
  /** Stable name (the asset transform identifies the bundler fs by it). */
  readonly name = 'zenfs';
  private fileCache: Map<string, string> = new Map();
  private bytesCache: Map<string, Uint8Array> = new Map();
  private isFileCache: Map<string, boolean> = new Map();
  // In-flight reads, keyed by path: concurrent reads of the SAME path share one
  // underlying `boundContext` read. Without this, N concurrent reads of one file
  // (e.g. every node_modules resolution reading the same package.json under the
  // R3-49d fast path's higher concurrency) issue N overlapping zenfs reads, and
  // zenfs reuses/detaches the read buffer between them — `buffer.set()` then throws
  // "Construct on a detached ArrayBuffer", which (mis)caches the file as absent and
  // breaks resolution. Deduping serializes same-path reads (and saves duplicate work).
  private readInflight: Map<string, Promise<string>> = new Map();
  private pendingChanges: Set<string> = new Set();
  private onFileChangedEmitter = new Emitter<CachedFSChangeEvent>();
  onFileChanged = this.onFileChangedEmitter.event;
  private watcherStarted = false;

  /** Gensync wrappers the resolver consumes (async-only — sync handlers throw). */
  readFile: Gensync<(filepath: string) => string>;
  isFile: Gensync<(filepath: string) => boolean>;

  constructor(public boundContext: BoundContext) {
    this.readFile = gensync({
      sync: (path: string): string => {
        throw new Error(`Synchronous file reads are not supported (path: ${path})`);
      },
      async: this.readFileAsync.bind(this),
    });
    this.isFile = gensync({
      sync: (path: string): boolean => {
        throw new Error(`Synchronous file existence checks are not supported (path: ${path})`);
      },
      async: this.isFileAsync.bind(this),
    });
    this.startWatcher().catch((err) => {
      logger.error('CachedFS: failed to start filesystem watcher', err);
    });
  }

  private async startWatcher(): Promise<void> {
    if (this.watcherStarted) return;
    this.watcherStarted = true;

    try {
      const watcher = this.boundContext.fs.promises.watch('/', { recursive: true });
      for await (const event of watcher) {
        const filename = event.filename;
        if (!filename) continue;
        const path = filename.toString();
        const normalized = path.startsWith('/') ? path : `/${path}`;

        if (normalized.includes('node_modules')) continue;

        this.fileCache.delete(normalized);
        this.bytesCache.delete(normalized);
        this.isFileCache.delete(normalized);
        this.pendingChanges.add(normalized);
        this.onFileChangedEmitter.fire({
          path: normalized,
          eventType: event.eventType as 'rename' | 'change',
        });
      }
    } catch (err) {
      logger.error('CachedFS: watcher iteration failed', err);
    }
  }

  /**
   * Records externally-reported changes (relayed from the parent, which is the
   * only side that can observe writes to the shared filesystem). Mirrors what
   * the local watcher would do: invalidate caches and queue the paths so the
   * next compile re-reads and re-transforms them.
   */
  markChanged(paths: string[]): void {
    for (const path of paths) {
      const normalized = path.startsWith('/') ? path : `/${path}`;
      if (normalized.includes('node_modules')) continue;

      this.fileCache.delete(normalized);
      this.bytesCache.delete(normalized);
      this.isFileCache.delete(normalized);
      this.pendingChanges.add(normalized);
      this.onFileChangedEmitter.fire({ path: normalized, eventType: 'change' });
    }
  }

  /** Drains and returns the set of paths that changed since the last call. */
  drainPendingChanges(): string[] {
    const changes = Array.from(this.pendingChanges);
    this.pendingChanges.clear();
    return changes;
  }

  resetCache(): void {
    this.isFileCache = new Map();
  }

  /**
   * Write THROUGH to the bound context (the mount table) — `/node_modules` writes
   * land on the CopyOnWrite writable side, `/empty.js` on the root tmpfs — then
   * update the read memo. Parent dirs are materialized first (the writable tmpfs
   * does not auto-create them). No bundler writes target `/app` (spec §3.4).
   */
  async writeFile(path: string, content: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) {
      await this.boundContext.fs.promises.mkdir(dir, { recursive: true }).catch(() => undefined);
    }
    await this.boundContext.fs.promises.writeFile(path, content);
    this.fileCache.set(path, content);
    this.isFileCache.set(path, true);
  }

  /**
   * Delete a file from the bound context (used to drop `/transpiled/<path>.js` on
   * `resetCompilation`, PRETRANSPILED_ARTIFACTS_SPEC §5.3) and update the memo.
   * Tolerates a missing file (the entry may never have been written through).
   */
  async deleteFile(path: string): Promise<void> {
    await this.boundContext.fs.promises.unlink(path).catch(() => undefined);
    this.fileCache.delete(path);
    this.bytesCache.delete(path);
    this.isFileCache.set(path, false);
  }

  /**
   * Batch hydration (R3-49b): pre-warm the read caches from a bulk snapshot the
   * host pushes at mount, so the bundler reads `/app` source + the bundled
   * `/node_modules` packages from memory instead of one Port round-trip per file
   * (the `loadNodeModules` cost — ~99% of cold boot). Coherence is unchanged: a
   * later edit invalidates the entry via `markChanged`/the watcher, exactly as for
   * a Port-read entry. Returns the number of files hydrated. Idempotent.
   */
  hydrate(snapshot: FsSnapshot): number {
    for (const { path, content } of snapshot) {
      const normalized = path.startsWith('/') ? path : `/${path}`;
      if (typeof content === 'string') {
        this.fileCache.set(normalized, content);
      } else {
        this.bytesCache.set(normalized, content);
      }
      this.isFileCache.set(normalized, true);
    }
    return snapshot.length;
  }

  async readFileAsync(path: string): Promise<string> {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    if (this.isFileCache.get(path) === false) {
      throw new Error(`File ${path} not found`);
    }

    // Share one underlying read across concurrent callers for the same path.
    const inflight = this.readInflight.get(path);
    if (inflight) return inflight;

    const promise = (async (): Promise<string> => {
      try {
        const content = await this.boundContext.fs.promises.readFile(path, 'utf8');
        const str = content as unknown as string;
        this.fileCache.set(path, str);
        this.isFileCache.set(path, true);
        return str;
      } catch (err) {
        // Only a GENUINE absence may negatively cache the path. A transient error
        // (e.g. a zenfs detached-buffer TypeError under concurrent reads) must not
        // permanently mark an existing file as missing — leave it uncached so a
        // later read retries.
        if (isNotFoundError(err)) {
          this.isFileCache.set(path, false);
        }
        throw err;
      } finally {
        this.readInflight.delete(path);
      }
    })();
    this.readInflight.set(path, promise);
    return promise;
  }

  /** Read a file as raw bytes (no utf8 decode) — for binary payloads such as the
   *  bundled `/package/` msgpack (R3-49a). Served from the bytes cache when present
   *  (batch-hydrated or previously read), so a hydrated package never crosses the
   *  Port; invalidated alongside the text cache on change. */
  async readBytesAsync(path: string): Promise<Uint8Array> {
    const cached = this.bytesCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const content = (await this.boundContext.fs.promises.readFile(path)) as unknown as Uint8Array;
    this.bytesCache.set(path, content);
    this.isFileCache.set(path, true);
    return content;
  }

  async isFileAsync(path: string): Promise<boolean> {
    if (this.fileCache.has(path)) {
      return true;
    }

    const cached = this.isFileCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const stats = await this.boundContext.fs.promises.stat(path);
      const isFile = stats.isFile();
      this.isFileCache.set(path, isFile);
      return isFile;
    } catch (err) {
      // A genuine absence is cached as "not a file"; a transient/unexpected error
      // is NOT cached (else a one-off failure permanently hides an existing file),
      // and is reported as "not currently a file" without poisoning the cache.
      if (isNotFoundError(err)) {
        this.isFileCache.set(path, false);
      }
      return false;
    }
  }
}

/** True for a genuine filesystem "not found" (vs a transient/unexpected error). */
function isNotFoundError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
