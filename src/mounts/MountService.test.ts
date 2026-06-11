import { MountService } from './MountService';
import { SandboxMount, RemovedMount, asMountRemoveReason } from './mountState';

const firestore: SandboxMount = { path: '/firestore', type: 'firestore', id: 'firestore' };
const other: SandboxMount = { path: '/scratch', type: 'memory', id: 'scratch' };

describe('MountService', () => {
  it('starts with no mounts', () => {
    expect(new MountService().getMounts()).toEqual([]);
  });

  it('adds and removes mounts', () => {
    const svc = new MountService();
    svc.add(firestore);
    expect(svc.getMounts()).toEqual([firestore]);
    svc.add(other);
    expect(svc.getMounts()).toEqual([firestore, other]);
    svc.remove('firestore');
    expect(svc.getMounts()).toEqual([other]);
  });

  it('replaces a mount with the same key rather than duplicating', () => {
    const svc = new MountService();
    svc.add(firestore);
    svc.add({ ...firestore, path: '/firestore', type: 'firestore-v2' });
    expect(svc.getMounts()).toEqual([{ path: '/firestore', type: 'firestore-v2', id: 'firestore' }]);
  });

  it('replays the current mounts immediately to new subscribers', () => {
    const svc = new MountService();
    svc.add(firestore);
    const seen: SandboxMount[][] = [];
    svc.onChange((m) => seen.push(m));
    expect(seen).toEqual([[firestore]]);
  });

  it('fires on change but suppresses no-op updates', () => {
    const svc = new MountService();
    const seen: SandboxMount[][] = [];
    svc.onChange((m) => seen.push(m)); // initial replay: []
    svc.add(firestore);
    svc.remove('does-not-exist'); // no-op
    svc.remove('firestore');
    expect(seen).toEqual([[], [firestore], []]);
  });

  it('fires on a rw→ro downgrade of the same mount (mode is not deduped, AM-3)', () => {
    const svc = new MountService();
    const rw: SandboxMount = { path: '/mnt/s1', type: 'firestore', id: 's1', mode: 'rw' };
    const seen: SandboxMount[][] = [];
    svc.onChange((m) => seen.push(m)); // initial replay: []
    svc.add(rw);
    svc.add({ ...rw, mode: 'ro' }); // same key, only mode changed → must fire
    expect(seen).toEqual([[], [rw], [{ ...rw, mode: 'ro' }]]);
  });

  it('stops notifying after dispose', () => {
    const svc = new MountService();
    const seen: SandboxMount[][] = [];
    const disposable = svc.onChange((m) => seen.push(m));
    disposable.dispose();
    svc.add(firestore);
    expect(seen).toEqual([[]]); // only the replay
  });

  it('surfaces the removed descriptor + reason to listeners (AM2-4)', () => {
    const svc = new MountService();
    svc.add(firestore);
    const removedSeen: RemovedMount[][] = [];
    svc.onChange((_m, removed) => removedSeen.push(removed)); // replay: []
    svc.remove('firestore', 'unshared');
    expect(removedSeen).toEqual([[], [{ ...firestore, reason: 'unshared' }]]);
  });

  it('defaults a removal reason to revoked, and replay/add carry no removed', () => {
    const svc = new MountService();
    const removedSeen: RemovedMount[][] = [];
    svc.onChange((_m, removed) => removedSeen.push(removed)); // replay: []
    svc.add(firestore); //                                       add: []
    svc.remove('firestore'); //                                  remove (default reason)
    expect(removedSeen).toEqual([[], [], [{ ...firestore, reason: 'revoked' }]]);
  });

  it('normalizes an unknown/absent wire reason to revoked', () => {
    expect(asMountRemoveReason('deleted')).toBe('deleted');
    expect(asMountRemoveReason('signed-out')).toBe('signed-out');
    expect(asMountRemoveReason('bogus')).toBe('revoked');
    expect(asMountRemoveReason(undefined)).toBe('revoked');
  });
});
