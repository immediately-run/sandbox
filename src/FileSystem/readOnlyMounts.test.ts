import { configure, fs, mount, umount, resolveMountConfig, InMemory, bindContext } from '@zenfs/core';

import { withReadOnlyMounts } from './readOnlyMounts';

// R3-48 G0-3 — the app-facing EROFS write-guard, exercised against a REAL in-process
// ZenFS mount table (ZenFS runs in Node). This is the §9 "mount hardening (Gate 0)"
// control: app code must not write under `/node_modules` or `/transpiled`, INCLUDING
// creating new paths (the PT2-6 criterion a naive credential-based read-only leaks).
const READ_ONLY = ['/node_modules', '/transpiled'];

describe('withReadOnlyMounts (G0-3 — app-facing EROFS guard)', () => {
  let guarded: ReturnType<typeof bindContext>['fs'];

  beforeEach(async () => {
    await configure({ disableAccessChecks: true, disableAsyncCache: true });
    for (const point of ['/app', ...READ_ONLY]) {
      await fs.promises.mkdir(point, { recursive: true }).catch(() => undefined);
      mount(point, await resolveMountConfig({ backend: InMemory }));
    }
    // Seed an existing file under a read-only mount so the overwrite case is real
    // (InMemory mounts don't auto-create parent dirs).
    await fs.promises.mkdir('/node_modules/react', { recursive: true });
    await fs.promises.writeFile('/node_modules/react/index.js', 'module.exports = {};');
    guarded = withReadOnlyMounts(bindContext({ root: '/', pwd: '/app' }).fs, READ_ONLY);
  });

  afterEach(() => {
    for (const point of ['/app', ...READ_ONLY]) {
      try {
        umount(point);
      } catch {
        /* not mounted */
      }
    }
  });

  it('rejects an overwrite of an existing file under a read-only mount with EROFS', async () => {
    await expect(guarded.promises.writeFile('/node_modules/react/index.js', 'hacked')).rejects.toMatchObject({
      code: 'EROFS',
    });
    // ...and the file is untouched.
    expect(await fs.promises.readFile('/node_modules/react/index.js', 'utf8')).toBe('module.exports = {};');
  });

  it('rejects creating a NEW file under a read-only mount with EROFS (no silent leak)', async () => {
    await expect(guarded.promises.writeFile('/node_modules/evil/new.js', 'x')).rejects.toMatchObject({
      code: 'EROFS',
    });
    await expect(fs.promises.readFile('/node_modules/evil/new.js', 'utf8')).rejects.toBeDefined();
  });

  it('rejects mkdir of a NEW directory under a read-only mount with EROFS', async () => {
    await expect(guarded.promises.mkdir('/transpiled/sneaky', { recursive: true })).rejects.toMatchObject({
      code: 'EROFS',
    });
  });

  it('allows a write under /app (not a read-only mount)', async () => {
    await guarded.promises.writeFile('/app/note.txt', 'hello');
    expect(await fs.promises.readFile('/app/note.txt', 'utf8')).toBe('hello');
  });

  it('allows reads under a read-only mount (only writes are guarded)', async () => {
    expect(await guarded.promises.readFile('/node_modules/react/index.js', 'utf8')).toBe('module.exports = {};');
  });
});
