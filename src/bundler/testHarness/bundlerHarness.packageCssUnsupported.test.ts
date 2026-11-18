import { NodeModule } from '../module-registry/NodeModule';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

/**
 * R3-565 — the allowed failure branch: a package file the preset has no
 * transformer for fails LOUD at transform time, naming the file — never an
 * opaque `SyntaxError` at evaluation.
 *
 * A package stylesheet of an extension the preset does not route (`.scss`, an
 * uppercase `.CSS`) is DATA with no chain: pre-fix it registered precompiled
 * and the first import evaluated its raw source as JavaScript
 * (`SyntaxError: Unexpected token '.'` — the 2026-09-06..08 outage shape,
 * reproduced for exactly these members by the round-1 review on the
 * `.css`/`.json`-only form of the fix). With the JS-family inversion it
 * registers uncompiled, `mapTransformers` refuses it, and the refusal surfaces
 * from `compile()` via `moduleFinishedPromise`'s recursion — a diagnosis naming
 * the package file, which is the branch the item's exit criterion allows
 * ("either applies it or fails at build time with the package and file
 * named"). The CLASS of unrouted data extensions is derived in
 * bundlerHarness.packageCss.test.ts's classification table; this file drives
 * the behavioral branch for the member the review reproduced.
 *
 * One harness, one compile per module realm (the babel loopback is one per
 * realm); the compile's expected throw is the assertion.
 */

const PACKAGE_UNSUPPORTED_FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'package-unsupported-fixture',
    main: 'src/main',
    dependencies: { 'css-dep': '1.0.0' },
  }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/main.ts': "import 'css-dep';\nexport default 1;\n",
};

describe('R3-565 — an unrouted package data file fails loud, never a SyntaxError', () => {
  let h: BundlerHarness;
  let restoreManifestSpy: () => void;

  beforeAll(async () => {
    // The outage's exact member: an uppercase .CSS package stylesheet, whose
    // raw bytes the pre-fix registration left as the module's compiled output.
    h = await createBundlerHarness(PACKAGE_UNSUPPORTED_FIXTURE, { forCompile: true });
    h.bundler.moduleRegistry.modules.set(
      'css-dep',
      new NodeModule(
        'css-dep',
        '1.0.0',
        {
          'package.json': { c: '{"name":"css-dep","version":"1.0.0"}', d: [], t: false },
          'index.js': {
            c: "require('./Omibox.CSS');\nmodule.exports = 'ok';",
            d: ['./Omibox.CSS'],
            t: true,
          },
          'Omibox.CSS': { c: '.omnibox-outer { color: rebeccapurple; }', d: [], t: false },
        },
        [],
      ),
    );
    const registry = (
      h.bundler as unknown as {
        moduleRegistry: { fetchManifest: (...a: unknown[]) => Promise<unknown> };
      }
    ).moduleRegistry;
    const spy = jest
      .spyOn(registry, 'fetchManifest')
      .mockImplementation(async () => [{ n: 'css-dep', v: '1.0.0', d: 0 }]);
    restoreManifestSpy = () => spy.mockRestore();
  }, 60000);

  afterAll(async () => {
    restoreManifestSpy();
    await h.teardown();
  });

  it('an uppercase `.CSS` package stylesheet fails at transform time naming the file — not the outage SyntaxError', async () => {
    const failure = await h.bundler.compile().then(
      () => 'compiled',
      (err: unknown) => String((err as Error)?.message ?? err),
    );
    // The loud branch: refused at transform time, the file named.
    expect(failure).not.toBe('compiled');
    expect(failure).toContain('No transformer for /node_modules/css-dep/Omibox.CSS');
    // And specifically not the outage's opaque evaluation error.
    expect(failure).not.toMatch(/Unexpected token|SyntaxError/);
  }, 60000);
});
