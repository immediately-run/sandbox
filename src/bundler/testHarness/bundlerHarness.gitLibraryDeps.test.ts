import { fs, mount, umount, resolveMountConfig, InMemory } from '@zenfs/core';

import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// R3-293 — a mounted git library brings its OWN dependencies. npm installs a library's
// closure beside it; the library-mount path has no such step, so the CDN `/dep_tree/`
// query (built from the APP's manifest, with git libraries stripped) never asked for what
// the library itself needs. The first import that reached into one died: grove's engine on
// `@immediately-run/mdx-plugins`, which grove declares and a shell consuming it has no
// reason to.
//
// These drive the real `loadNodeModules` and assert on the dependency map that reaches
// `fetchManifest` — i.e. what is actually sent to the CDN, not an internal helper's return.

const APP_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'consumer',
    main: 'src/index.ts',
    dependencies: {
      '@scope/lib': 'github:owner/repo#abc123',
      react: '^19.2.5',
    },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import x from '@scope/lib';\nexport default x;\n",
};

async function mountLibraryFs(mountPath: string, files: Record<string, string>): Promise<() => void> {
  const backing = await resolveMountConfig({ backend: InMemory });
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
      /* already gone */
    }
  };
}

const libPkg = (deps: Record<string, string>): string =>
  JSON.stringify({ name: '@scope/lib', version: '0.0.0', main: 'index.js', dependencies: deps });

describe('R3-293 a git library contributes its own dependencies to the CDN query', () => {
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

  /** Run the real `loadNodeModules` and return the dependency map it sent to the CDN.
   *  `parsedPackageJSON` is normally set by `processPackageJSON()` mid-compile; set it
   *  directly (as the libraryMountWait harness does) so this drives `loadNodeModules`
   *  alone. */
  async function depsSentToCdn(): Promise<Record<string, string>> {
    (h.bundler as unknown as { parsedPackageJSON: unknown }).parsedPackageJSON = JSON.parse(
      APP_FIXTURE['package.json'],
    );
    await h.bundler.initPreset('create-react-app'); // the preset augments the closure
    const registry = (
      h.bundler as unknown as {
        moduleRegistry: { fetchManifest: (...a: unknown[]) => Promise<unknown> };
      }
    ).moduleRegistry;
    let sent: Record<string, string> = {};
    const spy = jest.spyOn(registry, 'fetchManifest').mockImplementation(async (deps: unknown) => {
      sent = deps as Record<string, string>;
    });
    try {
      await (h.bundler as unknown as { loadNodeModules: () => Promise<void> }).loadNodeModules();
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  it("adds the library's dependency, which the app never declared", async () => {
    unmount = await mountLibraryFs('/mnt/deplib', {
      'package.json': libPkg({ '@scope/mdx-plugins': '0.3.0' }),
      'index.js': 'module.exports = 1;',
    });
    await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/deplib');

    const sent = await depsSentToCdn();

    expect(sent['@scope/mdx-plugins']).toBe('0.3.0');
    // The library itself still resolves from the mount, never the CDN.
    expect(sent['@scope/lib']).toBeUndefined();
  });

  it("the APP's pin wins a clash, and the disagreement is warned about, not silent", async () => {
    unmount = await mountLibraryFs('/mnt/clashlib', {
      'package.json': libPkg({ react: '^18.0.0' }),
      'index.js': 'module.exports = 1;',
    });
    await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/clashlib');

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sent = await depsSentToCdn();
      // One flat closure: the app's version is the one that serves both.
      expect(sent.react).toBe('^19.2.5');
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(' ')).toContain('react');
    } finally {
      warn.mockRestore();
    }
  });

  it('never forwards a git-form or self-hosted dependency to the CDN', async () => {
    unmount = await mountLibraryFs('/mnt/mixedlib', {
      'package.json': libPkg({
        // The CDN cannot resolve a git ref, and `concreteVersion()` would mis-default it.
        '@scope/nested': 'github:owner/nested#main',
        // Vendored per-app by addLocalModules at the version the APP pinned.
        '@immediately-run/sdk': '0.45.3',
        // An ordinary one, to prove the filter is selective rather than a blanket drop.
        'lodash-es': '^4.17.21',
      }),
      'index.js': 'module.exports = 1;',
    });
    await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/mixedlib');

    const sent = await depsSentToCdn();

    expect(sent['@scope/nested']).toBeUndefined();
    expect(sent['@immediately-run/sdk']).toBeUndefined();
    expect(sent['lodash-es']).toBe('^4.17.21');
  });

  it("stops contributing once the library's mount goes away", async () => {
    unmount = await mountLibraryFs('/mnt/gonelib', {
      'package.json': libPkg({ 'lodash-es': '^4.17.21' }),
      'index.js': 'module.exports = 1;',
    });
    await h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/gonelib');
    expect((await depsSentToCdn())['lodash-es']).toBe('^4.17.21');

    h.bundler.unmountGitLibraryAliases('@scope/lib');

    expect((await depsSentToCdn())['lodash-es']).toBeUndefined();
  });

  it('a library with no package.json contributes nothing and never fails the mount', async () => {
    unmount = await mountLibraryFs('/mnt/barelib', { 'index.js': 'module.exports = 1;' });

    await expect(h.bundler.registerGitLibraryMount('@scope/lib', '/mnt/barelib')).resolves.toBeUndefined();
    expect(await depsSentToCdn()).toBeDefined();
  });
});
