import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// R3-147: an exports-map-only package.json (no `main`) must resolve for a
// registered git-dependency module — the shape @immediately-run/file-explorer-ui
// ships (`exports: { ".": …, "./sdk": …, "./styles.css": … }`, all source paths).
const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'exports-map-fixture',
    main: 'src/index.ts',
    dependencies: {
      '@scope/lib': 'github:owner/repo#abc123',
    },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.ts': "import x from '@scope/lib';\nexport default x;\n",
};

describe('exports-map-only git dep resolution (R3-147)', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness(FIXTURE);
    await h.bundler.addGitDependencyModule('@scope/lib', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: '@scope/lib',
          version: '0.1.0',
          exports: {
            '.': './src/lib-ui/index.ts',
            './sdk': './src/lib-ui/sdk/index.ts',
            './styles.css': './src/lib-ui/styles.css',
          },
        }),
      },
      { path: 'src/lib-ui/index.ts', content: 'export const x = 42;', isModule: true },
      { path: 'src/lib-ui/sdk/index.ts', content: 'export const y = 43;', isModule: true },
      { path: 'src/lib-ui/styles.css', content: '.a{}', isModule: true },
    ]);
    h.resetSpies();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('resolves the bare import via the exports map', async () => {
    const resolved = await h.bundler.resolveAsync('@scope/lib', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/src/lib-ui/index.ts');
  });

  it('resolves the ./sdk subpath via the exports map', async () => {
    const resolved = await h.bundler.resolveAsync('@scope/lib/sdk', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/src/lib-ui/sdk/index.ts');
  });

  it('resolves the ./styles.css subpath via the exports map', async () => {
    const resolved = await h.bundler.resolveAsync('@scope/lib/styles.css', '/app/src/index.ts');
    expect(resolved).toBe('/node_modules/@scope/lib/src/lib-ui/styles.css');
  });
});
