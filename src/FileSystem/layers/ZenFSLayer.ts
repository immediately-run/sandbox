import { fs } from '@zenfs/core';

import * as logger from '../../utils/logger';
import { Emitter } from '../../utils/emitter';
import { FSLayer } from '../FSLayer';
import { MemoryFSLayer } from './MemoryFSLayer';

export interface ZenFSChangeEvent {
  path: string;
  eventType: 'rename' | 'change';
}

/**
 * FS layer backed by `@zenfs/core`'s node-compatible async API.
 *
 * The parent window hosts the actual zenfs instance and exposes it to the iframe
 * via a `MessagePort` (see `IFrameParentMessageBus.getFsPort`). The bundler mounts
 * that port as the zenfs `Port` backend in `src/index.ts` before this layer is
 * instantiated, so `fs.promises.*` calls here are transparently forwarded to the
 * parent.
 *
 * To keep the existing sync read path working (the resolver uses `gensync`), every
 * successful async read is mirrored into `MemoryFSLayer`, which serves as the sync
 * cache.
 */
export class ZenFSLayer extends FSLayer {
  private isFileCache: Map<string, boolean> = new Map();
  private pendingChanges: Set<string> = new Set();
  private onFileChangedEmitter = new Emitter<ZenFSChangeEvent>();
  onFileChanged = this.onFileChangedEmitter.event;
  private watcherStarted = false;

  constructor(private memoryFS: MemoryFSLayer) {
    super('zenfs');
    this.startWatcher().catch((err) => {
      logger.error('ZenFSLayer: failed to start filesystem watcher', err);
    });
  }

  private async startWatcher(): Promise<void> {
    if (this.watcherStarted) return;
    this.watcherStarted = true;

    try {
      const watcher = fs.promises.watch('/', { recursive: true });
      for await (const event of watcher) {
        const filename = event.filename;
        if (!filename) continue;
        const path = filename.toString();
        const normalized = path.startsWith('/') ? path : `/${path}`;

        if (normalized.includes('node_modules')) continue;

        this.memoryFS.files.delete(normalized);
        this.isFileCache.delete(normalized);
        this.pendingChanges.add(normalized);
        this.onFileChangedEmitter.fire({
          path: normalized,
          eventType: event.eventType as 'rename' | 'change',
        });
      }
    } catch (err) {
      logger.error('ZenFSLayer: watcher iteration failed', err);
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

  writeFile(path: string, content: string): void {
    this.memoryFS.writeFile(path, content);
  }

  readFileSync(path: string): string {
    return this.memoryFS.readFileSync(path);
  }

  async readFileAsync(path: string): Promise<string> {
    try {
      return this.memoryFS.readFileSync(path);
    } catch {
      // not cached; fall through to zenfs
    }

    if (this.isFileCache.get(path) === false) {
      throw new Error(`File ${path} not found`);
    }

    try {
      const content = await fs.promises.readFile(path, 'utf8');
      const str = content as unknown as string;
      this.memoryFS.writeFile(path, str);
      this.isFileCache.set(path, true);
      return str;
    } catch (err) {
      this.isFileCache.set(path, false);
      throw err;
    }
  }

  isFileSync(path: string): boolean {
    return this.memoryFS.isFileSync(path);
  }

  async isFileAsync(path: string): Promise<boolean> {
    if (this.memoryFS.isFileSync(path)) {
      return true;
    }

    const cached = this.isFileCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const stats = await fs.promises.stat(path);
      const isFile = stats.isFile();
      this.isFileCache.set(path, isFile);
      return isFile;
    } catch {
      this.isFileCache.set(path, false);
      return false;
    }
  }
}
