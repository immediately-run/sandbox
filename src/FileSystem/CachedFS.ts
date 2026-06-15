import { BoundContext } from '@zenfs/core';
import gensync, { Gensync } from 'gensync';

import * as logger from '../utils/logger';
import { Emitter } from '../utils/emitter';

export interface CachedFSChangeEvent {
  path: string;
  eventType: 'rename' | 'change';
}

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
  private isFileCache: Map<string, boolean> = new Map();
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

  async readFileAsync(path: string): Promise<string> {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    if (this.isFileCache.get(path) === false) {
      throw new Error(`File ${path} not found`);
    }

    try {
      const content = await this.boundContext.fs.promises.readFile(path, 'utf8');
      const str = content as unknown as string;
      this.fileCache.set(path, str);
      this.isFileCache.set(path, true);
      return str;
    } catch (err) {
      this.isFileCache.set(path, false);
      throw err;
    }
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
    } catch {
      this.isFileCache.set(path, false);
      return false;
    }
  }
}
