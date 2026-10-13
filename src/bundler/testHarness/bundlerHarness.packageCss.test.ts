import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import { EMBEDDED_TOOLCHAIN_HASH } from '../artifacts/embeddedToolchainHash';
import { NodeModule } from '../module-registry/NodeModule';
import { isJsFamilyFile } from '../presets/Preset';
import { createBundlerHarness, installEvalGlobals, mountInMemoryFs, type BundlerHarness } from './bundlerHarness';

/**
 * R3-565 — a dependency's stylesheet is applied, not executed.
 *
 * The package CDN hands the registry a package's files as `{ c, d, t }` entries,
 * and `_writePrecompiledModule` registered every one of them as an
 * already-compiled module whose `compiled` output IS the published bytes. For a
 * `.css` file that means the stylesheet itself is the "JavaScript" the first
 * import evaluates — `SyntaxError: Unexpected token '.'`, a dead app
 * (@immediately-run/omnibox@0.2.0, 2026-09-06..08). An app-local `.css` never
 * tripped it because `_transformModule` compiles those through
 * `mapTransformers`' css branch.
 *
 * The suite drives the REAL producer chain end to end, once, in `beforeAll` (the
 * babel loopback is one per module realm): a seeded `NodeModule` per dependency
 * (the registry's own shape, what `fetchModule` returns) + a
 * `jest.spyOn(registry, 'fetchManifest')` stub (no network, the rootPeers
 * pattern), then the bundler's own `compile()` + `evaluate()`: registration
 * (`loadModuleDependencies` → `_writePrecompiledModule`) → resolution →
 * transformation → evaluation. No module record is built by hand.
 *
 * Pre-fix, the first evaluation below dies with the production error
 * (`SyntaxError: Unexpected token '.'` on the `.` of `.omnibox-outer`) — the
 * fault-injection evidence the fix's cases must stay red against.
 */

/** The incident's shape, reduced: one dependency, one CSS import, one rule. */
const CSS = '.omnibox-outer { color: rebeccapurple; }';

const PACKAGE_DATA_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'package-data-fixture',
    main: 'src/main',
    dependencies: { 'css-dep': '1.0.0', 'json-dep': '1.0.0' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/main.ts':
    "import 'css-dep';\n" +
    "const data = require('json-dep');\n" +
    '(globalThis as Record<string, unknown>).__jsonDep = data;\n' +
    'export default 1;\n',
};

/** The seeded dependencies — the `NodeModule` shape the CDN's `fetchModule`
 *  returns, files exactly as the `/package/` endpoint lists them: the package's
 *  JS entry with its stylesheet in `d`, the stylesheet itself, a package.json,
 *  and (for `json-dep`) the required data file. */
const SEEDED_DEPENDENCIES = [
  new NodeModule(
    'css-dep',
    '1.0.0',
    {
      'package.json': { c: '{"name":"css-dep","version":"1.0.0"}', d: [], t: false },
      'index.js': {
        c: "require('./omnibox.css');\nmodule.exports = 'ok';",
        d: ['./omnibox.css'],
        t: true,
      },
      'omnibox.css': { c: CSS, d: [], t: false },
    },
    [],
  ),
  new NodeModule(
    'json-dep',
    '1.0.0',
    {
      'package.json': { c: '{"name":"json-dep","version":"1.0.0"}', d: [], t: false },
      'index.js': {
        c: "module.exports = require('./data.json');",
        d: ['./data.json'],
        t: true,
      },
      'data.json': { c: '{"answer":42}', d: [], t: false },
    },
    [],
  ),
];

/** A document double that RECORDS what the style-transformer injects, so a test
 *  can assert the stylesheet was APPLIED (a style node carrying the CSS), not
 *  merely that nothing threw. Replaces the plain `installEvalGlobals` document
 *  (which can't observe) after that call installs `location`/`window`. */
function installRecordingDocument(): () => string[] {
  const g = globalThis as unknown as { document?: unknown };
  const injected: string[] = [];
  const textOf = (content: unknown): string => (typeof content === 'string' ? content : String(content));
  g.document = {
    createElement: () => {
      const node: Record<string, unknown> = {
        setAttribute() {},
        appendChild(child: unknown) {
          if (node['textContent'] === undefined) node['textContent'] = '';
          node['textContent'] += textOf((child as { content?: unknown })?.content ?? '');
        },
        style: {},
      };
      return node;
    },
    createTextNode: (content: string) => ({ content }),
    head: {
      appendChild(child: Record<string, unknown>) {
        injected.push(textOf(child['textContent']));
      },
    },
    body: { appendChild() {} },
    getElementById: () => null,
    querySelector: () => null,
  };
  return () => injected;
}

describe('R3-565 — a package file that is data compiles through the preset chain', () => {
  let h: BundlerHarness;
  let restoreEval: () => void;
  let injectedStyles: () => string[];

  beforeAll(async () => {
    restoreEval = installEvalGlobals();
    injectedStyles = installRecordingDocument();
    h = await createBundlerHarness(PACKAGE_DATA_FIXTURE, { forCompile: true });
    for (const dependency of SEEDED_DEPENDENCIES) {
      h.bundler.moduleRegistry.modules.set(dependency.name, dependency);
    }
    const registry = (
      h.bundler as unknown as {
        moduleRegistry: { fetchManifest: (...a: unknown[]) => Promise<unknown> };
      }
    ).moduleRegistry;
    // The manifest query is the ONE network hop in the chain — stubbed with the
    // shape the CDN's /dep_tree/ returns, so both seeded dependencies resolve.
    const spy = jest
      .spyOn(registry, 'fetchManifest')
      .mockImplementation(async () => SEEDED_DEPENDENCIES.map((dep) => ({ n: dep.name, v: dep.version, d: 0 })));
    try {
      const evaluate = await h.bundler.compile();
      // First-load: runs the runtimes, then the entry — which imports `css-dep`
      // (whose JS requires its stylesheet) and requires `json-dep`.
      (evaluate as () => unknown)();
    } finally {
      spy.mockRestore();
    }
  }, 60000);

  afterAll(async () => {
    await h.teardown();
    injectedStyles();
    restoreEval();
  });

  it("a dependency's `.css` compiles to the style chain, not its raw source", () => {
    const cssModule = h.bundler.getModule('/node_modules/css-dep/omnibox.css');
    expect(cssModule).toBeDefined();
    // The style chain's signature: the id-stamped wrapper, carrying the rules —
    // not the raw stylesheet the pre-fix registration left as `compiled`.
    expect(cssModule?.compiled).toContain('createStyleNode');
    expect(cssModule?.compiled).toContain(CSS);
    expect(cssModule?.compiled).not.toBe(CSS);
  });

  it("a dependency's `.css` is applied — a style node carrying the rules is injected", () => {
    // Pre-fix this evaluation died on the entry import chain with
    // `SyntaxError: Unexpected token '.'` (the `.` of `.omnibox-outer`).
    expect(injectedStyles().some((css) => css.includes('.omnibox-outer'))).toBe(true);
  });

  it("a dependency's `.json` parses — `require` yields the object, not a SyntaxError", () => {
    expect((globalThis as Record<string, unknown>).__jsonDep).toEqual({ answer: 42 });
  });

  it('the JS-family classification derives its cases, not one favorite member', () => {
    // The class both consumers agree on: everything here is a package-file
    // extension seen in the wild. JS-family members register precompiled and
    // route to babel/raw-cjs; every data member rides the preset chain.
    const jsFamily = [
      '/node_modules/leftpad/index.js',
      '/node_modules/pkg/dist/index.mjs',
      '/node_modules/pkg/dist/index.cjs',
      '/node_modules/pkg/src/mod.ts',
      '/node_modules/pkg/src/mod.tsx',
      '/node_modules/pkg/src/mod.jsx',
      '/node_modules/pkg/dist/mts-file.mts',
      '/node_modules/pkg/dist/cts-file.cts',
      '/app/src/App.tsx',
    ];
    const data = [
      '/node_modules/@scope/pkg/dist/omnibox.css',
      '/node_modules/@scope/pkg/dist/Omibox.CSS',
      '/node_modules/@scope/pkg/dist/theme.scss',
      '/node_modules/pkg/data.json',
      '/node_modules/pkg/README.md',
      '/node_modules/pkg/logo.svg',
      '/node_modules/pkg/logo.png',
      '/node_modules/pkg/index.d.ts',
    ];
    const classify = (paths: string[]): string[] => paths.map((p) => `${p}:${isJsFamilyFile(p)}`);
    expect(classify(jsFamily)).toEqual(jsFamily.map((p) => `${p}:true`));
    expect(classify(data)).toEqual(data.map((p) => `${p}:false`));
  });

  it("a seeded 'artifact' for a package stylesheet is never adopted — it compiles through the chain", async () => {
    // The adoption seam (adoptSeededModules) replaces a registered-uncompiled
    // module with a seeded artifact's bytes. A crafted library zip that carries
    // an "artifact" entry for a DATA file (a stylesheet) must not have those
    // bytes adopted as the module's compiled JavaScript — the same registration
    // the CDN seam refuses. Drives the real producers: the library mount (the
    // artifact root), the L3 registration (addGitDependencyModule), and the
    // bundler's own seedArtifacts.
    const HOSTILE_ARTIFACT = '/* crafted artifact */ module.exports = "adopted";\n';
    const unmount = await mountInMemoryFs('/mnt/csslib', {
      'package.json': '{"name":"css-lib","version":"1.0.0","main":"index.js"}',
      'index.js': "require('./theme.css');\nmodule.exports = 'ok';",
      'theme.css': CSS,
      '.immediately.run/contribute-manifest.json': JSON.stringify({
        schemaVersion: 1,
        commitSha: 'lib-commit-sha',
        entries: [{ path: 'theme.css', sha: 'sha-theme', type: 'blob' }],
      }),
      '.immediately.run/artifacts/index.json': JSON.stringify({
        schemaVersion: 1,
        toolchain: {
          transpiler: '@immediately-run/transpiler',
          version: TRANSPILER_VERSION,
          toolchainHash: EMBEDDED_TOOLCHAIN_HASH,
          preset: 'react',
        },
        files: {
          '/theme.css': { srcSha: 'sha-theme', out: 'transpiled/theme.css.js', deps: [] },
        },
      }),
      '.immediately.run/artifacts/transpiled/theme.css.js': HOSTILE_ARTIFACT,
    });
    try {
      await h.bundler.registerGitLibraryMount('css-lib', '/mnt/csslib');
      await h.bundler.addGitDependencyModule('css-lib', [
        { path: 'package.json', content: '{"name":"css-lib","version":"1.0.0"}' },
        { path: 'index.js', content: "require('./theme.css');\nmodule.exports = 'ok';", isModule: true },
        { path: 'theme.css', content: CSS, isModule: true },
      ]);
      const seeded = await h.bundler.seedArtifacts({ dirtySet: new Set(), writableLayer: new Set() });
      expect(seeded.seeded).toBe(1); // the crafted entry validated + seeded

      const mod = await h.bundler.transformModule('/node_modules/css-lib/theme.css');
      expect(mod.compiled).toContain('createStyleNode'); // the chain, not the crafted bytes
      expect(mod.compiled).toContain(CSS);
      expect(mod.compiled).not.toBe(HOSTILE_ARTIFACT);
    } finally {
      unmount();
    }
  });
});
