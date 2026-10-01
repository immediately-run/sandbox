import { fs } from '@zenfs/core';

import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// R3-772 (BUNDLE_EMBEDDING §4c.3) [harness] — the bundler's confinement seam:
// `setResolutionConfinement(root)` makes every `resolveAsync` ride the
// resolver's `confineToRoot`, so a snapshot-mounted program's module resolution
// cannot leave the app root. The launch path (R3-773) sets it for snapshot
// mounts only; every other frame stays unconfined (the control case).

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'confined-fixture', main: 'src/index.ts' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import { ok } from './util';\nexport default ok;\n",
  'src/util.ts': 'export const ok = true;\n',
};

describe('R3-772 [harness] — setResolutionConfinement confines resolveAsync to the app root', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(FIXTURE);
    // A host-side tree the confined program must not reach — mounted OUTSIDE
    // /app in the sandbox's shared namespace, as /firestore is in production.
    await fs.promises.mkdir('/firestore', { recursive: true });
    await fs.promises.writeFile('/firestore/x.ts', 'export const secret = true;\n');
  });

  afterEach(async () => {
    await h.teardown();
    await fs.promises.rm('/firestore', { recursive: true, force: true });
  });

  it('unconfined (default): a ../.. escape RESOLVES — the hole the chroot closes', async () => {
    await expect(h.bundler.resolveAsync('../../firestore/x', '/app/src/index.ts')).resolves.toBe('/firestore/x.ts');
  });

  it('confined: the same escape is ModuleNotFound, and in-root resolution still works', async () => {
    h.bundler.setResolutionConfinement('/app');
    await expect(h.bundler.resolveAsync('../../firestore/x', '/app/src/index.ts')).rejects.toThrow(
      /Cannot find module/,
    );
    await expect(h.bundler.resolveAsync('/firestore/x', '/app/src/index.ts')).rejects.toThrow(/Cannot find module/);
    await expect(h.bundler.resolveAsync('./util', '/app/src/index.ts')).resolves.toBe('/app/src/util.ts');
  });

  it('lifting the confinement (null) restores resolution and drops the memoized failure', async () => {
    h.bundler.setResolutionConfinement('/app');
    await expect(h.bundler.resolveAsync('../../firestore/x', '/app/src/index.ts')).rejects.toThrow(
      /Cannot find module/,
    );
    h.bundler.setResolutionConfinement(null);
    await expect(h.bundler.resolveAsync('../../firestore/x', '/app/src/index.ts')).resolves.toBe('/firestore/x.ts');
  });
});
