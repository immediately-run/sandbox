import { fs } from '@zenfs/core';

import { NodeModule } from '../module-registry/NodeModule';
import { COMPILE_FIXTURE, createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// R3-772 (BUNDLE_EMBEDDING §4c.3) [harness] — the bundler's confinement seam:
// `setResolutionConfinement(root)` makes every `resolveAsync` ride the
// resolver's `confineToRoot`, so a snapshot-mounted program's module resolution
// cannot leave the app root. The launch path (R3-773) sets it for snapshot
// mounts only; every other frame stays unconfined (the control case).
//
// The cross-package case pins the fast-path divergence the round-1 review
// caught: the CDN-layout fast path accepts relative imports ACROSS packages
// where the confined full resolver refuses them, so a confined frame must skip
// the fast path entirely.

describe('R3-772 [harness] — setResolutionConfinement confines resolveAsync to the app root', () => {
  let h: BundlerHarness;

  const seedTwoPackages = () => {
    // Two CDN-layout packages; a's entry imports across into b. Both are
    // fast-path eligible (trivial package.json), so unconfined the cross-package
    // read resolves WITHOUT the full resolver.
    h.bundler.moduleRegistry.modules.set(
      'pkga',
      new NodeModule(
        'pkga',
        '1.0.0',
        {
          'package.json': { c: '{"name":"pkga","version":"1.0.0","main":"index.js"}', d: [], t: false },
          'index.js': { c: "require('../pkgb/secret.js');", d: ['../pkgb/secret.js'], t: false },
        },
        [],
      ),
    );
    h.bundler.moduleRegistry.modules.set(
      'pkgb',
      new NodeModule(
        'pkgb',
        '1.0.0',
        {
          'package.json': { c: '{"name":"pkgb","version":"1.0.0","main":"index.js"}', d: [], t: false },
          'index.js': { c: 'module.exports = {};', d: [], t: false },
          'secret.js': { c: 'module.exports = 1;', d: [], t: false },
        },
        [],
      ),
    );
  };

  beforeEach(async () => {
    h = await createBundlerHarness(COMPILE_FIXTURE);
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
    await expect(h.bundler.resolveAsync('./answer', '/app/src/index.ts')).resolves.toBe('/app/src/answer.ts');
  });

  it('confined: a cross-package relative import is refused even though the CDN fast path would serve it', async () => {
    seedTwoPackages();
    // Unconfined control: the fast path answers without the full resolver.
    await expect(h.bundler.resolveAsync('../pkgb/secret', '/node_modules/pkga/index.js')).resolves.toBe(
      '/node_modules/pkgb/secret.js',
    );
    // Confined: fast path skipped, full resolver re-confines to the importer's
    // own package subtree — the cross-package read is ModuleNotFound.
    h.bundler.setResolutionConfinement('/app');
    await expect(h.bundler.resolveAsync('../pkgb/secret', '/node_modules/pkga/index.js')).rejects.toThrow(
      /Cannot find module/,
    );
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
