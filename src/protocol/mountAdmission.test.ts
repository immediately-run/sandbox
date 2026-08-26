/**
 * The frame-side mount-admission gate (R3-352 / T4).
 *
 * These cases are the NEGATIVE SPACE of the mount table: every path that must
 * stay unnameable through `mount-add`, whoever sends it. The gate is the only
 * thing between a `mount-add` message and `zenfs.mount()`, so "refused here"
 * means "the mount table was never touched".
 */
import { HOST_MOUNT_ROOTS, REPO_MOUNT_ROOTS, admitMountAdd, isAllowedMountPath } from './mountAdmission';

describe('isAllowedMountPath — the host mount namespace', () => {
  it.each([
    ['/mnt/9f2c1ab3', 'the canonical mountPathFromId() address'],
    ['/mnt/9f2c1ab3/nested', 'a deeper path under the namespace'],
    ['/task/slot-1/roots', 'a §5.7 task file-delegation chroot'],
    ['/task/slot-1/roots/0', 'an indexed (array-param) delegation chroot'],
  ])('accepts %s (%s)', (path) => {
    expect(isAllowedMountPath(path)).toBe(true);
  });

  it.each([
    // The two paths the bundler owns. Shadowing either is the escalation.
    ['/app', 'the repo root the evaluator compiles'],
    ['/app/src', 'inside the repo root'],
    ['/node_modules', 'every bare import'],
    ['/node_modules/react', 'one bare import'],
    // Traversal back into them.
    ['/mnt/../app', 'traversal out of the namespace'],
    ['/task/../../app', 'traversal out of the namespace'],
    ['/mnt/./x', 'a non-normalized segment'],
    // Namespace roots themselves — mounting here would shadow every mount in it.
    ['/mnt', 'the namespace root itself'],
    ['/task', 'the namespace root itself'],
    // Malformed / other roots.
    ['/', 'the filesystem root'],
    ['//app', 'an empty first segment'],
    ['/mnt//x', 'an empty inner segment'],
    ['mnt/x', 'a relative path'],
    ['/spaces/x', 'a root that is not in the allowlist'],
    ['', 'the empty string'],
    ['/mnt/\0x', 'an embedded NUL'],
  ])('refuses %s (%s)', (path) => {
    expect(isAllowedMountPath(path)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ['/mnt/x']])('refuses the non-string %p', (path) => {
    expect(isAllowedMountPath(path)).toBe(false);
  });

  it('narrows to /mnt for the repo dual-mount (§11.2)', () => {
    expect(isAllowedMountPath('/mnt/9f2c1ab3', REPO_MOUNT_ROOTS)).toBe(true);
    // A task chroot is a legitimate mount-add path but NOT a repo address.
    expect(isAllowedMountPath('/task/slot-1/roots', REPO_MOUNT_ROOTS)).toBe(false);
    expect(isAllowedMountPath('/task/slot-1/roots', HOST_MOUNT_ROOTS)).toBe(true);
  });

  it('keeps the reserved roots out of the allowlist itself', () => {
    // Belt and braces: the refusals above hold because these are absent, not
    // because of a denylist someone has to remember to extend.
    expect(HOST_MOUNT_ROOTS).not.toContain('app');
    expect(HOST_MOUNT_ROOTS).not.toContain('node_modules');
  });
});

describe('admitMountAdd', () => {
  // A stand-in for the transferred `MessagePort`: `admitMountAdd` is pure and
  // only ever passes the port through, so identity is the whole contract.
  const port = () => ({ start: jest.fn(), close: jest.fn() } as unknown as MessagePort);

  it('admits a well-formed parent mount-add', () => {
    const p = port();
    const admission = admitMountAdd({ mount: { path: '/mnt/abc' }, ports: [p] });
    expect(admission).toEqual({ ok: true, path: '/mnt/abc', port: p });
  });

  it('refuses a mount-add at /app even though it is otherwise well-formed', () => {
    const admission = admitMountAdd({ mount: { path: '/app' }, ports: [port()] });
    expect(admission).toEqual({ ok: false, reason: 'path-outside-namespace', path: '/app' });
  });

  it('refuses a traversing path that resolves back into /app', () => {
    const admission = admitMountAdd({ mount: { path: '/mnt/../app' }, ports: [port()] });
    expect(admission).toEqual({ ok: false, reason: 'path-outside-namespace', path: '/mnt/../app' });
  });

  it('refuses a descriptor with no path at all', () => {
    expect(admitMountAdd({ mount: {}, ports: [port()] })).toMatchObject({
      ok: false,
      reason: 'path-outside-namespace',
    });
  });

  it('refuses a message with no descriptor and one with no port', () => {
    expect(admitMountAdd({ ports: [port()] })).toEqual({ ok: false, reason: 'no-descriptor' });
    expect(admitMountAdd({ mount: { path: '/mnt/abc' }, ports: [] })).toEqual({ ok: false, reason: 'no-port' });
    expect(admitMountAdd({ mount: { path: '/mnt/abc' } })).toEqual({ ok: false, reason: 'no-port' });
  });

  it('never returns a port for a refused path (nothing to mount, nothing to serve)', () => {
    const admission = admitMountAdd({ mount: { path: '/node_modules/react' }, ports: [port()] });
    expect(admission.ok).toBe(false);
    expect(admission).not.toHaveProperty('port');
  });
});
