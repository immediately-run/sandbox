import type { BoundContext } from '@zenfs/core';

import { CachedFS, CachedFSChangeEvent } from './CachedFS';

// CachedFS only ever touches `boundContext.fs.promises.{readFile,stat,watch}`, so a
// fake context lets us count backend reads and drive watcher events deterministically
// (the cache/watcher logic is what G0-2 extracts + nets, independent of ZenFS itself).
function controllableWatch() {
  const queue: Array<{ filename: string; eventType: string }> = [];
  let resolveNext: ((r: IteratorResult<{ filename: string; eventType: string }>) => void) | null = null;
  const push = (event: { filename: string; eventType: string }) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };
  const iterable: AsyncIterable<{ filename: string; eventType: string }> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          queue.length
            ? Promise.resolve({ value: queue.shift()!, done: false })
            : new Promise<IteratorResult<{ filename: string; eventType: string }>>((res) => {
                resolveNext = res;
              }),
      };
    },
  };
  return { iterable, push };
}

function makeContext(opts?: {
  readFile?: jest.Mock;
  stat?: jest.Mock;
  watch?: () => AsyncIterable<{ filename: string; eventType: string }>;
}) {
  const readFile = opts?.readFile ?? jest.fn(async () => 'CONTENT');
  const stat = opts?.stat ?? jest.fn(async () => ({ isFile: () => true }));
  const watch = opts?.watch ?? (() => controllableWatch().iterable);
  const context = { fs: { promises: { readFile, stat, watch } } } as unknown as BoundContext;
  return { context, readFile, stat };
}

/** Let the fire-and-forget watcher `for await` loop drain a pushed event. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('CachedFS (G0-2 — read memoization + change invalidation)', () => {
  it('memoizes a read: a second read of the same path avoids a backend round-trip', async () => {
    const { context, readFile } = makeContext();
    const fs = new CachedFS(context);

    expect(await fs.readFileAsync('/a.js')).toBe('CONTENT');
    expect(await fs.readFileAsync('/a.js')).toBe('CONTENT');

    expect(readFile).toHaveBeenCalledTimes(1); // second read served from fileCache
  });

  it('memoizes a not-found: repeated reads of a missing file throw without re-hitting the backend', async () => {
    const readFile = jest.fn(async () => {
      throw new Error('ENOENT');
    });
    const { context } = makeContext({ readFile });
    const fs = new CachedFS(context);

    await expect(fs.readFileAsync('/missing.js')).rejects.toThrow('ENOENT');
    await expect(fs.readFileAsync('/missing.js')).rejects.toThrow('not found'); // isFileCache=false short-circuit

    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('markChanged invalidates the cache, queues the path, and fires onFileChanged', async () => {
    const { context, readFile } = makeContext();
    const fs = new CachedFS(context);
    const events: CachedFSChangeEvent[] = [];
    fs.onFileChanged((e) => events.push(e));

    await fs.readFileAsync('/a.js'); // prime the cache (1 read)
    fs.markChanged(['/a.js']);

    // fired + queued
    expect(events).toEqual([{ path: '/a.js', eventType: 'change' }]);
    expect(fs.drainPendingChanges()).toEqual(['/a.js']);

    // invalidated → the next read hits the backend again (2 reads total)
    await fs.readFileAsync('/a.js');
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('normalizes a relative path to a leading-slash path in markChanged', async () => {
    const { context } = makeContext();
    const fs = new CachedFS(context);
    fs.markChanged(['a.js']);
    expect(fs.drainPendingChanges()).toEqual(['/a.js']);
  });

  it('skips node_modules paths in markChanged and shouldSkipLayer', async () => {
    const { context } = makeContext();
    const fs = new CachedFS(context);
    const events: CachedFSChangeEvent[] = [];
    fs.onFileChanged((e) => events.push(e));

    fs.markChanged(['/node_modules/react/index.js', '/src/App.tsx']);

    expect(events).toEqual([{ path: '/src/App.tsx', eventType: 'change' }]); // node_modules dropped
    expect(fs.drainPendingChanges()).toEqual(['/src/App.tsx']);
    expect(fs.shouldSkipLayer('/node_modules/react/index.js')).toBe(true);
    expect(fs.shouldSkipLayer('/src/App.tsx')).toBe(false);
  });

  it('drainPendingChanges drains once: a second drain is empty', async () => {
    const { context } = makeContext();
    const fs = new CachedFS(context);
    fs.markChanged(['/a.js', '/b.js']);

    expect(fs.drainPendingChanges().sort()).toEqual(['/a.js', '/b.js']);
    expect(fs.drainPendingChanges()).toEqual([]); // already drained
  });

  it('a watcher-relayed change invalidates the cache, queues, and fires', async () => {
    const watch = controllableWatch();
    const { context, readFile } = makeContext({ watch: () => watch.iterable });
    const fs = new CachedFS(context);
    const events: CachedFSChangeEvent[] = [];
    fs.onFileChanged((e) => events.push(e));

    await fs.readFileAsync('/a.js'); // prime (1 read)
    watch.push({ filename: 'a.js', eventType: 'change' });
    await flush();

    expect(events).toEqual([{ path: '/a.js', eventType: 'change' }]);
    expect(fs.drainPendingChanges()).toEqual(['/a.js']);

    await fs.readFileAsync('/a.js'); // re-read hits backend again
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('a watcher event under node_modules is ignored (no invalidation, no fire)', async () => {
    const watch = controllableWatch();
    const { context } = makeContext({ watch: () => watch.iterable });
    const fs = new CachedFS(context);
    const events: CachedFSChangeEvent[] = [];
    fs.onFileChanged((e) => events.push(e));

    watch.push({ filename: 'node_modules/react/index.js', eventType: 'change' });
    await flush();

    expect(events).toEqual([]);
    expect(fs.drainPendingChanges()).toEqual([]);
  });

  it('isFileAsync memoizes stat and treats a cached read as a known file', async () => {
    const stat = jest.fn(async () => ({ isFile: () => true }));
    const { context, readFile } = makeContext({ stat });
    const fs = new CachedFS(context);

    expect(await fs.isFileAsync('/a.js')).toBe(true);
    expect(await fs.isFileAsync('/a.js')).toBe(true);
    expect(stat).toHaveBeenCalledTimes(1); // isFileCache hit

    // a writeFile-populated entry counts as a known file without a stat
    await fs.writeFile('/b.js', 'x');
    expect(await fs.isFileAsync('/b.js')).toBe(true);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
  });
});
