import { configure, fs, mount, umount, resolveMountConfig, InMemory, bindContext } from '@zenfs/core';

import { withRaceTolerance } from './raceTolerance';

// R3-408 — the CLIENT half of the port-fs write-race fixes: the app-facing fs
// absorbs the StrictMode double-boot races (concurrent recursive mkdir, concurrent
// create of the same new file, create racing its parent's mkdir) so app code
// doesn't have to. Precise semantics are pinned with a scripted fake (call
// counts, error pass-through, all three node-style surfaces); a real in-process
// ZenFS mount guards the happy path against proxy regressions.

const errno = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });

/** A promises surface whose mkdir/writeFile/open succeed or fail per script. */
type ScriptedCalls = Array<{ method: string; args: unknown[] }>;
function scriptedSurface(behavior: {
  mkdir?: (path: unknown, opts?: unknown) => Promise<unknown>;
  writeFile?: (path: unknown, data?: unknown, opts?: unknown) => Promise<void>;
  appendFile?: (path: unknown, data?: unknown, opts?: unknown) => Promise<void>;
  open?: (path: unknown, flag?: unknown, mode?: unknown) => Promise<unknown>;
  stat?: (path: unknown) => Promise<unknown>;
}): Record<string, unknown> & { calls: ScriptedCalls } {
  const calls: ScriptedCalls = [];
  const track =
    <A extends unknown[]>(method: string, impl: ((...a: A) => unknown) | undefined, fallback: () => unknown) =>
    (...args: A): unknown => {
      calls.push({ method, args });
      return (impl ? impl(...args) : fallback()) as unknown;
    };
  const surface: Record<string, unknown> & { calls: ScriptedCalls } = {
    calls,
    mkdir: track('mkdir', behavior.mkdir, () => Promise.resolve(undefined)),
    writeFile: track('writeFile', behavior.writeFile, () => Promise.resolve()),
    appendFile: track('appendFile', behavior.appendFile, () => Promise.resolve()),
    open: track('open', behavior.open, () => Promise.resolve(42)),
    stat: track('stat', behavior.stat, () => Promise.resolve({ isDirectory: () => true })),
  };
  return surface;
}

const wrapPromises = (surface: Record<string, unknown>) =>
  withRaceTolerance({ promises: surface } as object) as {
    promises: Record<string, unknown> & { calls: Array<{ method: string; args: unknown[] }> };
  };

describe('withRaceTolerance — promises surface', () => {
  it('mkdir(recursive) EEXIST on a now-existing DIRECTORY resolves (the StrictMode lost race)', async () => {
    let exists = false;
    const surface = scriptedSurface({
      mkdir: () => {
        if (exists) return Promise.reject(errno('EEXIST'));
        exists = true;
        return Promise.resolve(undefined);
      },
      stat: () => Promise.resolve({ isDirectory: () => true }),
    });
    const wrapped = wrapPromises(surface);
    const first = await (wrapped.promises.mkdir as typeof fs.promises.mkdir)('/data/habits', {
      recursive: true,
    });
    const second = await (wrapped.promises.mkdir as typeof fs.promises.mkdir)('/data/habits', {
      recursive: true,
    });
    expect(first).toBeUndefined();
    expect(second).toBeUndefined(); // no EEXIST for the concurrent caller
    expect(surface.calls.filter((c) => c.method === 'mkdir')).toHaveLength(2);
  });

  it('mkdir(recursive) EEXIST where the path is a FILE still rejects', async () => {
    const surface = scriptedSurface({
      mkdir: () => Promise.reject(errno('EEXIST')),
      stat: () => Promise.resolve({ isDirectory: () => false, mode: 0o100644 }),
    });
    const wrapped = wrapPromises(surface);
    await expect(
      (wrapped.promises.mkdir as typeof fs.promises.mkdir)('/a-file', { recursive: true }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('mkdir NON-recursive EEXIST passes through untouched (plain fs.mkdir contract)', async () => {
    const surface = scriptedSurface({ mkdir: () => Promise.reject(errno('EEXIST')) });
    const wrapped = wrapPromises(surface);
    await expect(
      (wrapped.promises.mkdir as typeof fs.promises.mkdir)('/d', { recursive: false }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    // …and with no options at all.
    await expect((wrapped.promises.mkdir as typeof fs.promises.mkdir)('/d')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(surface.calls).toHaveLength(2); // no retries, no stat fallback
  });

  it('writeFile retries ONCE on EEXIST and succeeds when the retry sees the winner', async () => {
    let n = 0;
    const surface = scriptedSurface({
      writeFile: () => (n++ === 0 ? Promise.reject(errno('EEXIST')) : Promise.resolve()),
    });
    const wrapped = wrapPromises(surface);
    await (wrapped.promises.writeFile as typeof fs.promises.writeFile)('/deck.json', 'seed');
    expect(n).toBe(2);
  });

  it('writeFile retries ONCE on ENOENT (create racing its parent mkdir)', async () => {
    let n = 0;
    const surface = scriptedSurface({
      writeFile: () => (n++ === 0 ? Promise.reject(errno('ENOENT')) : Promise.resolve()),
    });
    const wrapped = wrapPromises(surface);
    await (wrapped.promises.writeFile as typeof fs.promises.writeFile)('/tx/new/file.json', '{}');
    expect(n).toBe(2);
  });

  it('a PERSISTENT writeFile error surfaces from the retry, unchanged', async () => {
    const surface = scriptedSurface({ writeFile: () => Promise.reject(errno('EISDIR')) });
    const wrapped = wrapPromises(surface);
    await expect((wrapped.promises.writeFile as typeof fs.promises.writeFile)('/a-dir', 'x')).rejects.toMatchObject({
      code: 'EISDIR',
    });
    expect(surface.calls).toHaveLength(1); // non-race codes never retry
  });

  it('writeFile EEXIST twice rejects (exactly one retry)', async () => {
    const surface = scriptedSurface({ writeFile: () => Promise.reject(errno('EEXIST')) });
    const wrapped = wrapPromises(surface);
    await expect((wrapped.promises.writeFile as typeof fs.promises.writeFile)('/locked', 'x')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(surface.calls).toHaveLength(2);
  });

  it('appendFile and open get the same single-retry semantics', async () => {
    let appends = 0;
    let opens = 0;
    const surface = scriptedSurface({
      appendFile: () => (appends++ === 0 ? Promise.reject(errno('EEXIST')) : Promise.resolve()),
      open: () => (opens++ === 0 ? Promise.reject(errno('ENOENT')) : Promise.resolve(7)),
    });
    const wrapped = wrapPromises(surface);
    await (wrapped.promises.appendFile as typeof fs.promises.appendFile)('/log', 'line');
    await expect((wrapped.promises.open as typeof fs.promises.open)('/f', 'w')).resolves.toBe(7);
    expect(appends).toBe(2);
    expect(opens).toBe(2);
  });

  it('other methods pass through with no retry logic', async () => {
    let reads = 0;
    const surface = scriptedSurface({});
    surface.readFile = () => {
      reads++;
      return Promise.reject(errno('ENOENT'));
    };
    const wrapped = wrapPromises(surface);
    await expect((wrapped.promises.readFile as typeof fs.promises.readFile)('/gone')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(reads).toBe(1);
  });
});

describe('withRaceTolerance — callback + sync surfaces', () => {
  const wrapTop = (surface: Record<string, unknown>, syncSurface: Record<string, unknown> = {}) =>
    withRaceTolerance({
      promises: surface,
      writeFile: (p: unknown, d: unknown, cb: (e: unknown, r?: unknown) => void) => {
        void p;
        void d;
        void cb;
      },
      ...{},
    } as object) as Record<string, unknown>;

  it('callback-style writeFile absorbs one EEXIST before invoking the callback', async () => {
    let n = 0;
    const target = {
      promises: scriptedSurface({}),
      writeFile: (_p: unknown, _d: unknown, cb: (e: unknown) => void) => {
        if (n++ === 0) cb(errno('EEXIST'));
        else cb(null);
      },
    };
    const wrapped = withRaceTolerance(target as object) as {
      writeFile: (p: unknown, d: unknown, cb: (e: unknown, r?: unknown) => void) => void;
    };
    const cbResult = await new Promise<unknown>((resolve) => {
      wrapped.writeFile('/deck.json', 'seed', (e) => resolve(e));
    });
    expect(cbResult).toBeNull();
    expect(n).toBe(2);
    void wrapTop;
  });

  it('writeFileSync retries once synchronously', () => {
    let n = 0;
    const target = {
      promises: scriptedSurface({}),
      writeFileSync: () => {
        if (n++ === 0) throw errno('EEXIST');
      },
    };
    const wrapped = withRaceTolerance(target as object) as {
      writeFileSync: (p: unknown, d: unknown) => void;
    };
    expect(() => wrapped.writeFileSync('/f', 'x')).not.toThrow();
    expect(n).toBe(2);
  });

  it('callback-style writeFile stops at ONE retry: a persistent error reaches the callback', async () => {
    let n = 0;
    const target = {
      promises: scriptedSurface({}),
      writeFile: (_p: unknown, _d: unknown, cb: (e: unknown) => void) => {
        n++;
        cb(errno('EEXIST'));
      },
    };
    const wrapped = withRaceTolerance(target as object) as {
      writeFile: (p: unknown, d: unknown, cb: (e: unknown, r?: unknown) => void) => void;
    };
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      wrapped.writeFile('/deck.json', 'seed', (e) => {
        seen.push(e);
        resolve();
      });
    });
    // Two attempts, and the caller's callback ran exactly once — the first
    // attempt's error must never reach it.
    expect(n).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ code: 'EEXIST' });
  });

  it('callback-style mkdir(recursive) EEXIST resolves via stat, without a second mkdir', async () => {
    let mkdirs = 0;
    const target = {
      promises: scriptedSurface({ stat: () => Promise.resolve({ isDirectory: () => true }) }),
      mkdir: (_p: unknown, _o: unknown, cb: (e: unknown) => void) => {
        mkdirs++;
        cb(errno('EEXIST'));
      },
    };
    const wrapped = withRaceTolerance(target as object) as {
      mkdir: (p: unknown, o: unknown, cb: (e: unknown, r?: unknown) => void) => void;
    };
    const cbResult = await new Promise<unknown>((resolve) => {
      wrapped.mkdir('/data/habits', { recursive: true }, (e) => resolve(e));
    });
    // The recovery is a stat, not a retry: mkdir is called once, not twice.
    expect(cbResult).toBeNull();
    expect(mkdirs).toBe(1);
  });

  it('callback-style mkdir(recursive) EEXIST where the path is a FILE reports the original error', async () => {
    const target = {
      promises: scriptedSurface({ stat: () => Promise.resolve({ isDirectory: () => false }) }),
      mkdir: (_p: unknown, _o: unknown, cb: (e: unknown) => void) => cb(errno('EEXIST')),
    };
    const wrapped = withRaceTolerance(target as object) as {
      mkdir: (p: unknown, o: unknown, cb: (e: unknown, r?: unknown) => void) => void;
    };
    const cbResult = await new Promise<unknown>((resolve) => {
      wrapped.mkdir('/data/habits', { recursive: true }, (e) => resolve(e));
    });
    expect(cbResult).toMatchObject({ code: 'EEXIST' });
  });

  it('callback-style mkdir NON-recursive keeps its EEXIST (no idempotency without the flag)', async () => {
    let mkdirs = 0;
    const target = {
      promises: scriptedSurface({ stat: () => Promise.resolve({ isDirectory: () => true }) }),
      mkdir: (_p: unknown, cb: (e: unknown) => void) => {
        mkdirs++;
        cb(errno('EEXIST'));
      },
    };
    const wrapped = withRaceTolerance(target as object) as {
      mkdir: (p: unknown, cb: (e: unknown, r?: unknown) => void) => void;
    };
    const cbResult = await new Promise<unknown>((resolve) => {
      wrapped.mkdir('/data', (e) => resolve(e));
    });
    expect(cbResult).toMatchObject({ code: 'EEXIST' });
    expect(mkdirs).toBe(1);
  });

  it('mkdirSync(recursive) EEXIST on a directory resolves; mkdirSync non-recursive passes through', () => {
    const target = {
      promises: scriptedSurface({}),
      mkdirSync: () => {
        throw errno('EEXIST');
      },
      statSync: () => ({ isDirectory: () => true }),
    };
    const wrapped = withRaceTolerance(target as object) as {
      mkdirSync: (p: unknown, o?: { recursive?: boolean }) => unknown;
    };
    expect(wrapped.mkdirSync('/d', { recursive: true })).toBeUndefined();
    expect(() => wrapped.mkdirSync('/d')).toThrowError(/EEXIST/);
  });
});

describe('withRaceTolerance — over a REAL zenfs mount (happy path)', () => {
  const MOUNT = '/r3-408-app';
  let appFs: ReturnType<typeof bindContext>['fs'];

  beforeEach(async () => {
    await configure({ disableAccessChecks: true, disableAsyncCache: true });
    await fs.promises.mkdir(MOUNT, { recursive: true }).catch(() => undefined);
    mount(MOUNT, await resolveMountConfig({ backend: InMemory }));
    appFs = withRaceTolerance(bindContext({ root: MOUNT, pwd: MOUNT }).fs) as ReturnType<typeof bindContext>['fs'];
  });

  afterEach(() => {
    try {
      umount(MOUNT);
    } catch {
      /* not mounted */
    }
  });

  it('a single boot seeds normally through every wrapped method', async () => {
    await appFs.promises.mkdir('/data/habits', { recursive: true });
    await appFs.promises.writeFile('/data/habits/habit-1.json', '{}');
    await appFs.promises.appendFile('/data/habits/habit-1.json', '\n');
    const fd = await appFs.promises.open('/data/habits/notes.txt', 'w');
    await fd.close();
    await appFs.promises.mkdir('/data/habits', { recursive: true }); // idempotent no-op
    expect(await fs.promises.readdir(`${MOUNT}/data/habits`)).toEqual(
      expect.arrayContaining(['habit-1.json', 'notes.txt']),
    );
    expect(await fs.promises.readFile(`${MOUNT}/data/habits/habit-1.json`, 'utf8')).toBe('{}\n');
  });

  it('two concurrent recursive mkdirs of the same fresh path both resolve (real core walk)', async () => {
    // Real ZenFS core's recursive walk + a real backend: two concurrent walks
    // of the same path. Whichever interleave occurs, both callers must see
    // success — the losing walk's EEXIST (if its segment-create loses) is
    // absorbed; if its exists-walk sees the winner's segment, it skips.
    await Promise.all([
      appFs.promises.mkdir('/deep/nested/tree', { recursive: true }),
      appFs.promises.mkdir('/deep/nested/tree', { recursive: true }),
    ]);
    expect(await fs.promises.exists(`${MOUNT}/deep/nested/tree`)).toBe(true);
  });

  it('two concurrent writeFiles of DIFFERENT new files both land (the seed shape)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => appFs.promises.writeFile(`/file-${i}.json`, JSON.stringify({ i }))),
    );
    for (let i = 0; i < 10; i++) {
      expect(await fs.promises.readFile(`${MOUNT}/file-${i}.json`, 'utf8')).toEqual(JSON.stringify({ i }));
    }
  });
});
