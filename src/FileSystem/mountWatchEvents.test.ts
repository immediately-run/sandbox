import { configure, fs, mount, umount, resolveMountConfig, InMemory, bindContext } from '@zenfs/core';

import { mountWatchRelay, withMountWatchRelay, relayEventFor, joinMountPath } from './mountWatchEvents';
import type { MountChange } from '../protocol/fsChange';

// R3-409 — the receiving half of the mount-anchored `fs-change` relay: a space
// mount's server-side changes (another tab's or member's writes) must surface
// as `fs.promises.watch` events on the app-facing fs, because zenfs's Port
// backend cannot forward them itself. Exercised against a REAL in-process
// ZenFS mount table and the REAL wrapped surface (the exact shape handed to
// app code), so the event shape (eventType + relative filename) is what an app
// actually receives — and LOCAL writes keep firing through core, merged into
// the same iterator.

const MOUNT = '/mnt/test-space';

const setup = async () => {
  await configure({ disableAccessChecks: true, disableAsyncCache: true });
  await fs.promises.mkdir(MOUNT, { recursive: true }).catch(() => undefined);
  mount(MOUNT, await resolveMountConfig({ backend: InMemory }));
  // The app-facing shape: bound fs + the relay wrapper, exactly as index.ts
  // stacks it (relay outermost).
  const appFs = withMountWatchRelay(bindContext({ root: '/', pwd: '/' }).fs) as ReturnType<typeof bindContext>['fs'];
  return { appFs, teardown: () => umount(MOUNT) };
};

const collect = (appFs: ReturnType<typeof bindContext>['fs'], path: string, recursive: boolean) => {
  const events: Array<{ eventType: string; filename: string }> = [];
  const iterator = appFs.promises.watch(path, { recursive });
  const pump = (async () => {
    for await (const ev of iterator) events.push({ eventType: ev.eventType, filename: String(ev.filename) });
  })();
  return {
    events,
    wait: async (ms = 10) => {
      await new Promise((r) => setTimeout(r, ms));
    },
    close: async () => {
      await iterator.return?.();
      await pump;
    },
  };
};

describe('mountWatchEvents — pure helpers', () => {
  it('add/remove map to rename; change maps to change (Node watch semantics)', () => {
    expect(relayEventFor('/mnt/x', true, '/mnt/x', { path: '/a.txt', kind: 'add' })).toEqual({
      eventType: 'rename',
      filename: 'a.txt',
    });
    expect(relayEventFor('/mnt/x', true, '/mnt/x', { path: '/a.txt', kind: 'change' })).toEqual({
      eventType: 'change',
      filename: 'a.txt',
    });
    expect(relayEventFor('/mnt/x', true, '/mnt/x', { path: '/a.txt', kind: 'remove' })!.eventType).toBe('rename');
  });

  it('joinMountPath anchors mount-relative paths and tolerates a trailing slash', () => {
    expect(joinMountPath('/mnt/x', '/data/a.txt')).toBe('/mnt/x/data/a.txt');
    expect(joinMountPath('/mnt/x/', '/data/a.txt')).toBe('/mnt/x/data/a.txt');
    expect(joinMountPath('/mnt/x', 'data/a.txt')).toBe('/mnt/x/data/a.txt');
  });

  it('a change outside the watched root is not delivered; recursion gates descendants', () => {
    expect(relayEventFor('/mnt/x', true, '/mnt/other', { path: '/a.txt', kind: 'add' })).toBeNull();
    // Deep descendant: only with recursive.
    expect(relayEventFor('/mnt/x', false, '/mnt/x', { path: '/a/b.txt', kind: 'add' })).toBeNull();
    expect(relayEventFor('/mnt/x', true, '/mnt/x', { path: '/a/b.txt', kind: 'add' })).toEqual({
      eventType: 'rename',
      filename: 'a/b.txt',
    });
    // The watched path itself is delivered either way.
    expect(relayEventFor('/mnt/x', false, '/mnt/x', { path: '/', kind: 'change' })?.eventType).toBe('change');
  });
});

describe('mountWatchEvents — watch delivery through the app-facing fs', () => {
  it("a remote member's write fires the frame's watch on the mount, with the changed path", async () => {
    const { appFs, teardown } = await setup();
    const w = collect(appFs, MOUNT, true);
    try {
      mountWatchRelay.emit(MOUNT, [{ path: '/games/1/moves/0.txt', kind: 'add' }]);
      await w.wait();
      expect(w.events).toEqual([{ eventType: 'rename', filename: 'games/1/moves/0.txt' }]);
    } finally {
      await w.close();
      teardown();
    }
  });

  it('a modification is a change event; a removal is a rename', async () => {
    const { appFs, teardown } = await setup();
    const w = collect(appFs, MOUNT, true);
    try {
      mountWatchRelay.emit(MOUNT, [
        { path: '/tick.txt', kind: 'change' },
        { path: '/gone.txt', kind: 'remove' },
      ]);
      await w.wait();
      expect(w.events).toEqual([
        { eventType: 'change', filename: 'tick.txt' },
        { eventType: 'rename', filename: 'gone.txt' },
      ]);
    } finally {
      await w.close();
      teardown();
    }
  });

  it('LOCAL writes and REMOTE relays merge into one iterator, in arrival order', async () => {
    const { appFs, teardown } = await setup();
    const w = collect(appFs, MOUNT, true);
    try {
      // Local: the frame writes through its own fs (core emits the event).
      await appFs.promises.writeFile(`${MOUNT}/local.txt`, 'x');
      // Remote: another tab's write arrives via the relay.
      mountWatchRelay.emit(MOUNT, [{ path: '/remote.txt', kind: 'add' }]);
      await w.wait(20);
      expect(w.events).toEqual([
        { eventType: 'change', filename: 'local.txt' },
        { eventType: 'rename', filename: 'remote.txt' },
      ]);
    } finally {
      await w.close();
      teardown();
    }
  });

  it('events are BUFFERED while the consumer is not iterating (none dropped)', async () => {
    const { appFs, teardown } = await setup();
    const iterator = appFs.promises.watch(MOUNT, { recursive: true });
    const events: Array<{ eventType: string; filename: string }> = [];
    try {
      // Emit BEFORE any consumer iterates.
      mountWatchRelay.emit(MOUNT, [{ path: '/early.txt', kind: 'add' }]);
      await new Promise((r) => setTimeout(r, 10));
      for await (const ev of iterator) {
        events.push({ eventType: ev.eventType, filename: String(ev.filename) });
        break; // take exactly the buffered one
      }
      expect(events).toEqual([{ eventType: 'rename', filename: 'early.txt' }]);
    } finally {
      await iterator.return?.();
      teardown();
    }
  });

  it('a watch on a DIFFERENT mount receives nothing (no ambient broadcast)', async () => {
    const { appFs, teardown } = await setup();
    const OTHER = '/mnt/other-space';
    await fs.promises.mkdir(OTHER, { recursive: true }).catch(() => undefined);
    mount(OTHER, await resolveMountConfig({ backend: InMemory }));
    const w = collect(appFs, OTHER, true);
    try {
      mountWatchRelay.emit(MOUNT, [{ path: '/private.txt', kind: 'add' }]);
      await w.wait();
      expect(w.events).toEqual([]);
    } finally {
      await w.close();
      umount(OTHER);
      teardown();
    }
  });

  it('a non-recursive watch sees direct children only', async () => {
    const { appFs, teardown } = await setup();
    const w = collect(appFs, MOUNT, false);
    try {
      mountWatchRelay.emit(MOUNT, [
        { path: '/spike.json', kind: 'add' },
        { path: '/deep/nested.txt', kind: 'add' },
      ]);
      await w.wait();
      expect(w.events).toEqual([{ eventType: 'rename', filename: 'spike.json' }]);
    } finally {
      await w.close();
      teardown();
    }
  });

  it('closing the watch stops delivery (and does not break the relay for others)', async () => {
    const { appFs, teardown } = await setup();
    const w1 = collect(appFs, MOUNT, true);
    const w2 = collect(appFs, MOUNT, true);
    await w1.close();
    mountWatchRelay.emit(MOUNT, [{ path: '/after-close.txt', kind: 'add' }]);
    await w2.wait();
    expect(w1.events).toEqual([]);
    expect(w2.events).toEqual([{ eventType: 'rename', filename: 'after-close.txt' }]);
    await w2.close();
    teardown();
  });

  it('malformed changes are skipped without breaking the batch', async () => {
    const { appFs, teardown } = await setup();
    const w = collect(appFs, MOUNT, true);
    try {
      mountWatchRelay.emit(MOUNT, [
        { path: 42 as unknown as string, kind: 'add' },
        { path: '', kind: 'add' },
        { path: '/ok.txt', kind: 'add' },
      ]);
      await w.wait();
      expect(w.events).toEqual([{ eventType: 'rename', filename: 'ok.txt' }]);
    } finally {
      await w.close();
      teardown();
    }
  });
});
