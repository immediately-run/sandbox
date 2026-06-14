import { BoundContext } from '@zenfs/core';

import * as logger from '../utils/logger';
import { Emitter } from '../utils/emitter';
import { FSLayer } from './FSLayer';

export interface CachedFSChangeEvent {
  path: string;
  eventType: 'rename' | 'change';
}

/**
 * Read-memoizing FS layer over a `@zenfs/core` bound context (extracted from the
 * former `ZenFSLayer` — Gate 0 sub-PR G0-2, a behavior-preserving move so the
 * caching/watcher logic has its own home + unit net before the G0-4 mount-table
 * flip wires it onto a single ZenFS-backed read path).
 *
 * The parent window hosts the actual zenfs instance and exposes it to the iframe
 * via a `MessagePort` (see `IFrameParentMessageBus.getFsPort`). The bundler mounts
 * that port as the zenfs `Port` backend in `src/index.ts` before this layer is
 * instantiated, so `fs.promises.*` calls here are transparently forwarded to the
 * parent.
 *
 * Successful reads are memoized in an in-memory `fileCache` so repeated reads of the
 * same path (e.g. `package.json` lookups during resolution) avoid extra round-trips to
 * the parent. The watcher invalidates cache entries when the underlying file changes,
 * and `markChanged` mirrors that for parent-relayed writes the watcher can't see across
 * the iframe boundary.
 */
export class CachedFS extends FSLayer {
  private fileCache: Map<string, string> = new Map();
  private isFileCache: Map<string, boolean> = new Map();
  private pendingChanges: Set<string> = new Set();
  private onFileChangedEmitter = new Emitter<CachedFSChangeEvent>();
  onFileChanged = this.onFileChangedEmitter.event;
  private watcherStarted = false;

  constructor(public boundContext: BoundContext) {
    super('zenfs');
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

  shouldSkipLayer(path: string): boolean {
    return path.includes('node_modules');
  }

  resetCache(): void {
    this.isFileCache = new Map();
  }

  writeFile(path: string, content: string): Promise<void> {
    this.fileCache.set(path, content);
    return Promise.resolve();
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
