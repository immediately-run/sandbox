/**
 * R3-284 — a superseded `mount-add` must be quiet, and must not disturb a good mount.
 *
 * The bug was cosmetic and the risk was not. Every dispatched boot printed a red
 * `mount revoked — access forbidden`, because the host's `request-mounts` replay revokes
 * the port of the first, speculative announcement before minting a replacement — so the
 * frame's queued first `mount-add` meets the FS2-4 rejector's terminal `EACCES`. That is
 * the rejector doing exactly what it was designed for; meeting it with `logger.error` on
 * every healthy boot is what teaches readers to ignore `forbidden`.
 *
 * The risk was that the race was benign only by ACCIDENT: `resolveMountConfig` happened to
 * run before the `umount`/`mount` pair, so a stale announcement could not tear down the
 * live mount at that path — and nothing asserted it. These tests assert it.
 */
import { applyMountAdd, isSupersededAnnouncement, type MountSequenceOps } from './mountSequence';

type FakeFs = { tag: string };

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

function ops(over: Partial<MountSequenceOps<FakeFs>> = {}) {
  const calls: string[] = [];
  const base: MountSequenceOps<FakeFs> = {
    resolve: async () => {
      calls.push('resolve');
      return { tag: 'fresh' };
    },
    umount: (p) => void calls.push(`umount:${p}`),
    materialize: async (p) => void calls.push(`materialize:${p}`),
    mount: (p, fs) => void calls.push(`mount:${p}:${fs.tag}`),
    closePort: () => void calls.push('closePort'),
    ...over,
  };
  return { ops: base, calls };
}

describe('isSupersededAnnouncement — narrow on purpose', () => {
  it('recognises the FS2-4 terminal reply by its code', () => {
    expect(isSupersededAnnouncement(coded('EACCES', 'mount revoked — access forbidden'))).toBe(true);
  });

  it('falls back to the message when a wrapper lost the code', () => {
    expect(isSupersededAnnouncement(new Error('EACCES: mount revoked'))).toBe(true);
  });

  it('does NOT swallow ENOENT — the thousands of ordinary module probes are not revocations', () => {
    expect(isSupersededAnnouncement(coded('ENOENT'))).toBe(false);
  });

  it('does NOT swallow a timeout, a transport failure, or an unrecognised error', () => {
    expect(isSupersededAnnouncement(coded('ETIMEDOUT'))).toBe(false);
    expect(isSupersededAnnouncement(new Error('port closed unexpectedly'))).toBe(false);
    expect(isSupersededAnnouncement(new Error('access denied'))).toBe(false); // not the token
    expect(isSupersededAnnouncement(undefined)).toBe(false);
    expect(isSupersededAnnouncement(null)).toBe(false);
    expect(isSupersededAnnouncement('EACCES')).toBe(false); // a bare string is not an error
  });

  it('prefers the code over the message, so a mislabelled message cannot widen it', () => {
    expect(isSupersededAnnouncement(coded('ETIMEDOUT', 'EACCES somewhere in the text'))).toBe(false);
  });
});

describe('applyMountAdd — the ordering IS the contract', () => {
  it('resolves the port BEFORE it touches the mount table', async () => {
    const { ops: o, calls } = ops();
    await expect(applyMountAdd('/mnt/abc', o)).resolves.toEqual({ status: 'mounted' });
    expect(calls).toEqual(['resolve', 'umount:/mnt/abc', 'materialize:/mnt/abc', 'mount:/mnt/abc:fresh']);
  });

  it('tolerates umount throwing when nothing was mounted there', async () => {
    const { ops: o, calls } = ops({
      umount: () => {
        throw new Error('not mounted');
      },
    });
    await expect(applyMountAdd('/mnt/abc', o)).resolves.toEqual({ status: 'mounted' });
    expect(calls).toContain('mount:/mnt/abc:fresh');
  });
});

describe('applyMountAdd — a superseded announcement', () => {
  const superseded = () => ops({ resolve: async () => Promise.reject(coded('EACCES', 'mount revoked')) });

  it('reports superseded rather than throwing, so nothing logs an error', async () => {
    const { ops: o } = superseded();
    await expect(applyMountAdd('/mnt/abc', o)).resolves.toEqual({ status: 'superseded' });
  });

  it('LEAVES THE GOOD MOUNT SERVING — it never reaches umount or mount', async () => {
    // The invariant the whole module exists to state. Before R3-284 this held only
    // because `resolveMountConfig` happened to be written above the teardown; move the
    // teardown up and a stale announcement starts unmounting a live corpus.
    const { ops: o, calls } = superseded();
    await applyMountAdd('/mnt/abc', o);
    expect(calls).not.toContain('umount:/mnt/abc');
    expect(calls.some((c) => c.startsWith('mount:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('materialize:'))).toBe(false);
  });

  it('closes its own end of the revoked port rather than orphaning the channel', async () => {
    const { ops: o, calls } = superseded();
    await applyMountAdd('/mnt/abc', o);
    expect(calls).toContain('closePort');
  });

  it('survives a closePort that throws (the host already closed it)', async () => {
    const { ops: o } = ops({
      resolve: async () => Promise.reject(coded('EACCES')),
      closePort: () => {
        throw new Error('already closed');
      },
    });
    await expect(applyMountAdd('/mnt/abc', o)).resolves.toEqual({ status: 'superseded' });
  });
});

describe('applyMountAdd — a GENUINE failure still surfaces', () => {
  it('rethrows a real revocation-unrelated error unchanged, so the caller logs it', async () => {
    const boom = coded('ETIMEDOUT', 'port timed out');
    const { ops: o, calls } = ops({ resolve: async () => Promise.reject(boom) });
    await expect(applyMountAdd('/mnt/abc', o)).rejects.toBe(boom);
    // …and it did not silently half-apply anything either.
    expect(calls).toEqual([]);
  });

  it('rethrows an error from the mount itself (past the supersession check)', async () => {
    const boom = new Error('mount failed');
    const { ops: o } = ops({
      mount: () => {
        throw boom;
      },
    });
    await expect(applyMountAdd('/mnt/abc', o)).rejects.toBe(boom);
  });
});
