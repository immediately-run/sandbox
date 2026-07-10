import { fs, mount, umount, resolveMountConfig, InMemory } from '@zenfs/core';

import { MountService } from '../../mounts/MountService';
import type { SandboxMount } from '../../mounts/mountState';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// LIBRARY_MOUNTS_SPEC L3 wait-for-arrival (R3-147): the host pushes a library
// `mount-add` only after fetching the repo over REST, so on a cold boot the
// first compile can outrun the mount — found live: file-commander's
// exports-map library resolved to `undefined` on every cold boot and rendered
// an error until reload. `registerDeclaredGitLibraries` now WAITS (bounded,
// `libraryMountWaitMs`) for a declared library's mount before letting
// resolution proceed. These tests drive the private boot step directly with a
// real `MountService`, simulating the host push arriving late / never / early.

const APP_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'git-lib-consumer',
    main: 'src/index.ts',
    dependencies: {
      '@scope/lib': 'github:owner/repo#abc123',
    },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import x from '@scope/lib';\nexport default x;\n",
};

const LIB_FILES: Record<string, string> = {
  'package.json': '{"name":"@scope/lib","version":"0.0.0","main":"index.js"}',
  'index.js': 'module.exports = 42;',
};

const MOUNT_PATH = '/mnt/wait-test-lib';

async function mountLibraryFs(mountPath: string, files: Record<string, string>): Promise<() => void> {
  const backing = await resolveMountConfig({ backend: InMemory });
  await fs.promises.mkdir(mountPath, { recursive: true }).catch(() => undefined);
  mount(mountPath, backing);
  for (const [rel, content] of Object.entries(files)) {
    const abs = `${mountPath}/${rel}`;
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => undefined);
    await fs.promises.writeFile(abs, content);
  }
  return () => {
    try {
      umount(mountPath);
    } catch {
      /* not mounted */
    }
  };
}

const descriptor: SandboxMount = {
  path: MOUNT_PATH,
  type: 'github',
  id: 'github:owner/repo@abc123',
  mode: 'ro',
  moduleName: '@scope/lib',
};

type BundlerInternals = {
  mounts: MountService;
  libraryMountWaitMs: number;
  parsedPackageJSON: unknown;
  registerDeclaredGitLibraries(): Promise<void>;
};

describe('L3 wait-for-arrival: first compile waits for a declared git-library mount', () => {
  let h: BundlerHarness;
  let svc: MountService;
  let internals: BundlerInternals;
  let unmount: (() => void) | null = null;

  beforeEach(async () => {
    h = await createBundlerHarness(APP_FIXTURE);
    svc = new MountService();
    internals = h.bundler as unknown as BundlerInternals;
    internals.mounts = svc;
    internals.parsedPackageJSON = JSON.parse(APP_FIXTURE['package.json']);
  });

  afterEach(async () => {
    unmount?.();
    unmount = null;
    await h.teardown();
  });

  it('a mount arriving AFTER the boot step started is awaited, registered, and resolves', async () => {
    internals.libraryMountWaitMs = 5_000;
    const bootStep = internals.registerDeclaredGitLibraries();

    // Simulate the host's late push: fs mounted, then the descriptor announced.
    await new Promise((r) => setTimeout(r, 100));
    unmount = await mountLibraryFs(MOUNT_PATH, LIB_FILES);
    svc.add(descriptor);

    await bootStep;
    const resolved = await h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/index.js');
    expect(await fs.promises.readFile(resolved, 'utf8')).toBe('module.exports = 42;');
  });

  it('an already-arrived mount settles immediately via the onChange replay', async () => {
    unmount = await mountLibraryFs(MOUNT_PATH, LIB_FILES);
    svc.add(descriptor);
    internals.libraryMountWaitMs = 5_000;

    const started = Date.now();
    await internals.registerDeclaredGitLibraries();
    expect(Date.now() - started).toBeLessThan(1_000); // no timeout-length stall

    const resolved = await h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/index.js');
  });

  it('a mount that never arrives times out, warns, and resolution fails normally', async () => {
    internals.libraryMountWaitMs = 100;

    await internals.registerDeclaredGitLibraries();

    await expect(h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts')).rejects.toThrow();
  });

  it('an app with no git-form deps is untouched by the wait (no stall)', async () => {
    internals.parsedPackageJSON = { dependencies: { react: '^19.0.0' } };
    internals.libraryMountWaitMs = 5_000;

    const started = Date.now();
    await internals.registerDeclaredGitLibraries();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
