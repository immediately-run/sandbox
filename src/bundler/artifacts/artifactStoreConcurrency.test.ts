// R3-900 — reproduction + regression: an edit invalidates and recompiles in quick
// succession, and a second fs-change can do so again before the first settles.
// `invalidate` starts an async unlink of the module's /transpiled file (tracked in
// `pendingDeletes`, which `consult` awaits) but `writeThrough` wrote straight past
// it: two writers, or a write and an in-flight unlink, reached one tmpfs path, and
// ZenFS `commitNew` answered the second create with EEXIST. The store now
// serialises all writes/deletes per path, and a rejected cache write is a missed
// cache entry, never a load failure.
//
// The store runs against the REAL stack (ZenFS InMemory, the tmpfs /transpiled is
// in production, behind the production CachedFS) — the fault is a real scheduling
// interleaving, not a stub's.

import { bindContext, configure, fs as zfs } from '@zenfs/core';
import { CachedFS } from '../../FileSystem/CachedFS';
import { ArtifactStore } from './artifactStore';
import { getEmbeddedToolchain } from './embeddedToolchain';

const MOD = '/app/src/components/FilmSection.tsx';

async function makeStore(): Promise<{ store: ArtifactStore; fs: CachedFS }> {
  await configure({ disableAccessChecks: true, disableAsyncCache: true });
  const fs = new CachedFS(bindContext({ root: '/', pwd: '/' }));
  await zfs.promises.mkdir('/transpiled', { recursive: true }).catch(() => undefined);
  const store = new ArtifactStore(fs, getEmbeddedToolchain());
  store.addRoot('/app');
  return { store, fs };
}

/** Run an interleaving N times, collecting any rejection. */
async function race(times: number, fn: (s: ArtifactStore) => Promise<void>): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (let i = 0; i < times; i++) {
    const { store } = await makeStore();
    try {
      await fn(store);
    } catch (e) {
      failures.push(e);
    }
  }
  return failures;
}

describe('R3-900: a recompile never fails on its own cache file', () => {
  it('invalidate, then two concurrent writeThrough calls, settles with the last writer’s content and no rejection', async () => {
    // The reported interleaving: edit → invalidate starts the unlink; the recompile
    // writes through; a second fs-change recompiles again before the first settles.
    // (Pre-fix this is the window in which ZenFS `commitNew` throws EEXIST — the
    // owner’s screenshot. Loop to make the scheduling window likely to open.)
    const failures = await race(25, async (store) => {
      await store.writeThrough(MOD, 'v1', []);
      store.invalidate(MOD);
      const w1 = store.writeThrough(MOD, 'v2', []);
      store.invalidate(MOD);
      const w2 = store.writeThrough(MOD, 'v3', []);
      await Promise.all([w1, w2]);
      const onDisk = await store.consult(MOD);
      expect(onDisk?.content).toBe('v3');
    });
    expect(failures).toEqual([]);
  });

  it('a consult racing the delete-then-rewrite never reads a torn or stale entry', async () => {
    const failures = await race(25, async (store) => {
      await store.writeThrough(MOD, 'v1', []);
      store.invalidate(MOD);
      const w = store.writeThrough(MOD, 'v2', []);
      const c = store.consult(MOD);
      await Promise.all([w, c]);
      const hit = await c;
      // null (missed the window — fine, caller live-transpiles) or the new bytes,
      // never the OLD ones: invalidate already dropped this module from the store.
      expect(hit === null || hit.content === 'v2').toBe(true);
    });
    expect(failures).toEqual([]);
  });

  it('a rejected cache write PROPAGATES — the caller is where it fails soft (and one failure never wedges the path)', async () => {
    const { store, fs } = await makeStore();
    jest.spyOn(fs, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('File exists'), { code: 'EEXIST' }));
    await expect(store.writeThrough(MOD, 'v1', [])).rejects.toMatchObject({ code: 'EEXIST' });
    // The path is not wedged: the next op on it runs.
    await expect(store.writeThrough(MOD, 'v2', [])).resolves.toBeUndefined();
    expect((await store.consult(MOD))?.content).toBe('v2');
  });
});
