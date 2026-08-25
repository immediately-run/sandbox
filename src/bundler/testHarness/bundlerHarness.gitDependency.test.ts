import { fs } from '@zenfs/core';

import { gitDependencyNames } from '../gitDependency';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// LIBRARY_MOUNTS_SPEC L2 [harness] — settle Q2 (sub-mount vs. local-module
// registration) with a harness test. A git-form `dependencies` entry
// (`"@scope/lib":"github:owner/repo#abc123"`) resolves a bare `import '@scope/lib'`
// from REGISTERED bytes under `/node_modules/@scope/lib/` (the registration path,
// `addGitDependencyModule`), with NO CDN `/dep_tree/`/`/package/` fetch — and the
// name is stripped from the CDN query by `registryResolvedNames()`.

// A fixture declaring a git dep AND a semver dep, plus an app entry importing the
// git dep. The semver dep proves the strip is selective (it still goes to the CDN).
const GIT_DEP_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'git-dep-fixture',
    main: 'src/index.ts',
    dependencies: {
      '@scope/lib': 'github:owner/repo#abc123',
      leftpad: '^1.0.0',
    },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import x from '@scope/lib';\nexport default x;\n",
};

describe('L2 [harness] git-dependency resolves from a registered local module, not the CDN', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(GIT_DEP_FIXTURE);
    // Register the library the way L3's host-mount step will — write its files on
    // the CoW writable side + register the module file as a bundler Module.
    await h.bundler.addGitDependencyModule('@scope/lib', [
      {
        path: 'package.json',
        content: '{"name":"@scope/lib","version":"0.0.0","main":"index.js"}',
      },
      { path: 'index.js', content: 'module.exports = 42;', isModule: true },
    ]);
    h.resetSpies();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('resolves the bare import to the registered /node_modules path and reads the registered bytes', async () => {
    const resolved = await h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/index.js');

    const content = await fs.promises.readFile(resolved, 'utf8');
    expect(content).toBe('module.exports = 42;');
  });

  it('issues NO CDN/dep_tree/package fetch for the git dep (registration path, not CDN)', async () => {
    await h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts');
    // The network spy records every lazy registry fetch; none should be for the
    // git-dep package.
    expect(h.fetchOps.some((op) => op.module === '@scope/lib')).toBe(false);
    expect(h.fetchOps).toEqual([]);
  });

  it('strips the git dep — but NOT the semver dep — from the CDN query (gitDependencyNames)', () => {
    const deps = (JSON.parse(GIT_DEP_FIXTURE['package.json']) as { dependencies: Record<string, string> }).dependencies;
    const names = gitDependencyNames(deps);
    expect(names.has('@scope/lib')).toBe(true); // git dep → stripped (resolves locally)
    expect(names.has('leftpad')).toBe(false); // semver dep → NOT stripped (CDN)
  });
});
