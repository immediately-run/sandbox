import { fs, mount, umount, resolveMountConfig, InMemory } from '@zenfs/core';

import { MountService } from '../../mounts/MountService';
import type { SandboxMount } from '../../mounts/mountState';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// LIBRARY_MOUNTS_SPEC L3 [harness] — SANDBOX half: when the host mounts a
// git-library repo at `/mnt/<hash>` and tags the mount with a package name, the
// sandbox walks the mounted tree and registers it under `/node_modules/<name>/`
// (via L2's `addGitDependencyModule`), so the bundler resolves the bare import
// from the mounted repo with NO CDN fetch. These tests SIMULATE the host push by
// mounting an InMemory fs at `/mnt/...` and calling `registerGitLibraryMount`.

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

/** Mount an InMemory fs at `mountPath` seeded with `files` (rel → content), the
 *  way the host mounts a git-library repo's read-only fs. Returns an unmount fn. */
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

describe('L3 [harness] git-library mount registers under /node_modules and resolves with no CDN', () => {
  let h: BundlerHarness;
  let unmount: (() => void) | null = null;

  beforeEach(async () => {
    h = await createBundlerHarness(APP_FIXTURE);
  });

  afterEach(async () => {
    unmount?.();
    unmount = null;
    await h.teardown();
  });

  it('walks the mounted repo and resolves the bare import from the registered bytes (no CDN fetch)', async () => {
    unmount = await mountLibraryFs('/mnt/testlib', {
      'package.json': '{"name":"@scope/lib","version":"0.0.0","main":"index.js"}',
      'index.js': 'module.exports = 42;',
    });
    h.resetSpies();

    await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/testlib');

    const resolved = await h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/index.js');

    const content = await fs.promises.readFile(resolved, 'utf8');
    expect(content).toBe('module.exports = 42;');

    // No CDN/dep_tree/package fetch for the git lib — it came from the mount.
    expect(h.fetchOps.some((op) => op.module === '@scope/lib')).toBe(false);
  });

  it('registers nested files at their relative paths', async () => {
    unmount = await mountLibraryFs('/mnt/nestedlib', {
      'package.json': '{"name":"@scope/nested","version":"0.0.0","main":"dist/index.js"}',
      'dist/index.js': 'module.exports = "nested";',
    });
    h.resetSpies();

    await h.bundler.registerGitLibraryMount('@scope/nested', '/mnt/nestedlib');

    const resolved = await h.bundler.resolveAsync('@scope/nested', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/nested/dist/index.js');
    const content = await fs.promises.readFile(resolved, 'utf8');
    expect(content).toBe('module.exports = "nested";');
  });

  // R3-292 replaced the copy with a mount alias, which retires the threat this case was
  // written for rather than defending it: destination paths were once built out of
  // `readdir` names, so a hostile name had to be screened or it could escape the package
  // root. Nothing is written now, so there is no destination to escape to. Asserting the
  // NEW property instead of leaving the old assertion to pass vacuously.
  it('writes nothing: a hostile readdir name cannot manifest a file anywhere', async () => {
    unmount = await mountLibraryFs('/mnt/hostilelib', {
      'package.json': '{"name":"@scope/hostile","version":"0.0.0","main":"index.js"}',
      'index.js': 'module.exports = 1;',
    });

    const fsp = (
      h.bundler as unknown as {
        fs: { boundContext: { fs: { promises: { readdir: (p: string) => Promise<string[]> } } } };
      }
    ).fs.boundContext.fs.promises;
    const realReaddir = fsp.readdir.bind(fsp);
    const spy = jest.spyOn(fsp, 'readdir').mockImplementation(async (p: string) => {
      if (p === '/mnt/hostilelib') {
        return ['package.json', 'index.js', '../escape.js', 'a/b.js', 'x\0y.js'];
      }
      return realReaddir(p);
    });

    try {
      await h.bundler.registerGitLibraryMount('@scope/hostile', '/mnt/hostilelib');
    } finally {
      spy.mockRestore();
    }

    // Registration never reads the tree at all, so the hostile names are inert.
    await expect(fs.promises.readFile('/node_modules/escape.js', 'utf8')).rejects.toBeTruthy();
    await expect(fs.promises.readFile('/node_modules/@scope/escape.js', 'utf8')).rejects.toBeTruthy();
    // The library still resolves — through the alias, not through copied bytes.
    const content = await fs.promises.readFile('/node_modules/@scope/hostile/index.js', 'utf8');
    expect(content).toBe('module.exports = 1;');
  });

  // The R3-292 crash, as a test. A library repo carries files a consumer can never import —
  // lint configs, tests, CI — and the CLI pre-transpiles the whole repo, so an artifact
  // exists for them too. While registration EAGERLY registered every module-extension file,
  // `adoptSeededModules` (which only touches already-registered modules) adopted those
  // artifacts and resolved their dependencies, dying on a devDependency of the LIBRARY that
  // the consumer never declared: `Cannot find module 'globals' from …/eslint.config.js`.
  it('does not pull an unimported library file into the module graph', async () => {
    unmount = await mountLibraryFs('/mnt/dirtylib', {
      'package.json': '{"name":"@scope/dirty","version":"0.0.0","main":"index.js"}',
      'index.js': 'module.exports = "clean";',
      // Never imported by the consumer, and imports something only the library dev has.
      'eslint.config.js': "import globals from 'globals';\nexport default [globals];\n",
      'src/thing.test.ts': "import { it } from 'vitest';\nit('x', () => {});\n",
    });
    h.resetSpies();

    await h.bundler.registerGitLibraryMount('@scope/dirty', '/mnt/dirtylib');

    const modules = (h.bundler as unknown as { modules: Map<string, unknown> }).modules;
    const registered = [...modules.keys()].filter((k) => k.startsWith('/node_modules/@scope/dirty'));
    // Nothing from the library is in the graph until something imports it.
    expect(registered).toEqual([]);

    // And the entry still resolves and reads, lazily, through the alias.
    const resolved = await h.bundler.resolveAsync('@scope/dirty', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/dirty/index.js');
    expect(await fs.promises.readFile(resolved, 'utf8')).toBe('module.exports = "clean";');
  });

  it('registerDeclaredGitLibraries (boot step) registers a declared dep from a known mount', async () => {
    unmount = await mountLibraryFs('/mnt/bootlib', {
      'package.json': '{"name":"@scope/lib","version":"0.0.0","main":"index.js"}',
      'index.js': 'module.exports = 7;',
    });

    // Give the bundler a real MountService carrying the descriptor the host would
    // have added on `mount-add`, and the parsed package.json with the git dep.
    const mountService = new MountService();
    const descriptor: SandboxMount = {
      path: '/mnt/bootlib',
      moduleName: '@scope/lib',
      type: 'github',
      mode: 'ro',
    };
    mountService.add(descriptor);
    (h.bundler as unknown as { mounts: MountService }).mounts = mountService;
    (h.bundler as unknown as { parsedPackageJSON: unknown }).parsedPackageJSON = JSON.parse(
      APP_FIXTURE['package.json'],
    );

    h.resetSpies();

    await (
      h.bundler as unknown as {
        registerDeclaredGitLibraries: () => Promise<void>;
      }
    ).registerDeclaredGitLibraries();

    const resolved = await h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/index.js');
    const content = await fs.promises.readFile(resolved, 'utf8');
    expect(content).toBe('module.exports = 7;');
    expect(h.fetchOps.some((op) => op.module === '@scope/lib')).toBe(false);
  });
});
