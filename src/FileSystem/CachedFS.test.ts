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
  writeFile?: jest.Mock;
  mkdir?: jest.Mock;
}) {
  const readFile = opts?.readFile ?? jest.fn(async () => 'CONTENT');
  const stat = opts?.stat ?? jest.fn(async () => ({ isFile: () => true }));
  const watch = opts?.watch ?? (() => controllableWatch().iterable);
  // writeFile now writes THROUGH to the bound context (mkdir -p + writeFile), so the
  // fake context needs both — see CachedFS.writeFile.
  const writeFile = opts?.writeFile ?? jest.fn(async () => undefined);
  const mkdir = opts?.mkdir ?? jest.fn(async () => undefined);
  const context = { fs: { promises: { readFile, stat, watch, writeFile, mkdir } } } as unknown as BoundContext;
  return { context, readFile, stat, writeFile, mkdir };
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
      // A genuine filesystem not-found carries `code: 'ENOENT'` (kerium/zenfs errno);
      // only such errors are negatively memoized (a transient error must not poison).
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const { context } = makeContext({ readFile });
    const fs = new CachedFS(context);

    await expect(fs.readFileAsync('/missing.js')).rejects.toThrow('ENOENT');
    await expect(fs.readFileAsync('/missing.js')).rejects.toThrow('not found'); // isFileCache=false short-circuit

    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('does NOT negatively cache a transient (non-ENOENT) error — a later read retries and succeeds', async () => {
    // Reproduces the R3-49d failure mode: a zenfs detached-ArrayBuffer TypeError under
    // concurrent reads must not permanently mark an existing file as missing.
    let calls = 0;
    const readFile = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('Cannot perform Construct on a detached ArrayBuffer');
      return 'RECOVERED';
    });
    const { context } = makeContext({ readFile });
    const fs = new CachedFS(context);

    await expect(fs.readFileAsync('/flaky.js')).rejects.toThrow('detached');
    // NOT short-circuited as "not found" — the retry actually hits the backend again.
    expect(await fs.readFileAsync('/flaky.js')).toBe('RECOVERED');
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent reads of the same path into one backend round-trip', async () => {
    let resolveRead: ((v: string) => void) | null = null;
    const readFile = jest.fn(() => new Promise<string>((res) => { resolveRead = res; }));
    const { context } = makeContext({ readFile });
    const fs = new CachedFS(context);

    const a = fs.readFileAsync('/shared.js');
    const b = fs.readFileAsync('/shared.js');
    resolveRead!('CONTENT');

    expect(await a).toBe('CONTENT');
    expect(await b).toBe('CONTENT');
    expect(readFile).toHaveBeenCalledTimes(1); // one shared in-flight read
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

  it('skips node_modules paths in markChanged (the mount has no watcher)', async () => {
    const { context } = makeContext();
    const fs = new CachedFS(context);
    const events: CachedFSChangeEvent[] = [];
    fs.onFileChanged((e) => events.push(e));

    fs.markChanged(['/node_modules/react/index.js', '/src/App.tsx']);

    expect(events).toEqual([{ path: '/src/App.tsx', eventType: 'change' }]); // node_modules dropped
    expect(fs.drainPendingChanges()).toEqual(['/src/App.tsx']);
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

  it('writeFile writes THROUGH to the bound context (mkdir -p + writeFile) and memoizes', async () => {
    const { context, readFile, writeFile, mkdir } = makeContext();
    const fs = new CachedFS(context);

    await fs.writeFile('/node_modules/react/index.js', 'module.exports = {};');

    // parent dirs are materialized first, then the file is written through
    expect(mkdir).toHaveBeenCalledWith('/node_modules/react', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith('/node_modules/react/index.js', 'module.exports = {};');

    // the write is memoized: a subsequent read is served from the cache (no backend read)
    expect(await fs.readFileAsync('/node_modules/react/index.js')).toBe('module.exports = {};');
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('CachedFS — batch hydration (R3-49b)', () => {
  it('serves a hydrated text file from memory with no Port round-trip', async () => {
    const { context, readFile } = makeContext();
    const fs = new CachedFS(context);

    const n = fs.hydrate([{ path: '/app/src/App.tsx', content: 'export const App = 1;' }]);
    expect(n).toBe(1);

    expect(await fs.readFileAsync('/app/src/App.tsx')).toBe('export const App = 1;');
    expect(await fs.isFileAsync('/app/src/App.tsx')).toBe(true);
    expect(readFile).not.toHaveBeenCalled(); // never crossed the Port
  });

  it('serves a hydrated binary file (bundled package msgpack) from memory', async () => {
    const { context, readFile } = makeContext();
    const fs = new CachedFS(context);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    fs.hydrate([{ path: '/app/.tinkerable/packages/react.msgpack', content: bytes }]);

    expect(await fs.readBytesAsync('/app/.tinkerable/packages/react.msgpack')).toBe(bytes);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('normalizes a leading-slash-less hydrated path', async () => {
    const { context } = makeContext();
    const fs = new CachedFS(context);
    fs.hydrate([{ path: 'app/x.ts', content: 'x' }]);
    expect(await fs.readFileAsync('/app/x.ts')).toBe('x');
  });

  it('invalidates a hydrated entry on markChanged — the next read crosses the Port', async () => {
    const readFile = jest.fn(async () => 'EDITED');
    const { context } = makeContext({ readFile });
    const fs = new CachedFS(context);

    fs.hydrate([{ path: '/app/src/App.tsx', content: 'ORIGINAL' }]);
    expect(await fs.readFileAsync('/app/src/App.tsx')).toBe('ORIGINAL');
    expect(readFile).not.toHaveBeenCalled();

    fs.markChanged(['/app/src/App.tsx']); // parent-relayed edit
    expect(await fs.readFileAsync('/app/src/App.tsx')).toBe('EDITED');
    expect(readFile).toHaveBeenCalledTimes(1); // re-read from the Port after invalidation
  });

  it('invalidates a hydrated binary entry on markChanged', async () => {
    const readFile = jest.fn(async () => new Uint8Array([9]));
    const { context } = makeContext({ readFile });
    const fs = new CachedFS(context);

    fs.hydrate([{ path: '/app/pkg.msgpack', content: new Uint8Array([1]) }]);
    expect(await fs.readBytesAsync('/app/pkg.msgpack')).toEqual(new Uint8Array([1]));
    fs.markChanged(['/app/pkg.msgpack']);
    expect(await fs.readBytesAsync('/app/pkg.msgpack')).toEqual(new Uint8Array([9]));
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
