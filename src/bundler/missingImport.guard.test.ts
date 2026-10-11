import { underAppRoot } from '../fsLayout';
import { createBundlerHarness, installEvalGlobals } from './testHarness/bundlerHarness';
import { ModuleNotFoundError } from '../errors/ModuleNotFound';

// R3-899 — the evaluate() guard's own test: a module whose COMPILATION failed
// (the cold-load graph's movies.ts, carrying the ModuleNotFoundError for the
// dangling avatar.jpg import) must THROW that original error when evaluated,
// never hand its dependents EMPTY exports. On the pre-fix code this returned
// exports = {} — the report's `TypeError: Cannot read properties of undefined`
// hole — so this test FAILS without the fix (the round-1 reviewers' finding:
// every other test in the diff passed on origin/main).
jest.setTimeout(60000);

describe('R3-899 — the evaluate() guard (a failed compile is never evaluated)', () => {
  it('evaluate() on the failed module throws the ORIGINAL ModuleNotFoundError, not empty exports', async () => {
    const restore = installEvalGlobals();
    const h = await createBundlerHarness(
      {
        'package.json': JSON.stringify({ name: 'missing-asset-fixture', main: 'src/main' }),
        'src/main.ts': "import { TITLE } from './data/movies';\nexport default TITLE;\n",
        'src/data/movies.ts': "import avatar from '../assets/posters/avatar.jpg';\nexport const TITLE = avatar;\n",
        // avatar.jpg deliberately absent — the dangling import.
      },
      { forCompile: true },
    );
    try {
      // The compile boundary rejects (moduleFinishedPromise sees the graph
      // failure) — catch it, then drive the GUARD directly on the failed module.
      await h.bundler.compile().catch(() => undefined);
      const movies = h.bundler.getModule(underAppRoot('/src/data/movies.ts'));
      expect(movies).toBeDefined();
      expect(movies!.compilationError).toBeInstanceOf(ModuleNotFoundError);
      // THE GUARD: pre-fix this evaluated the string "null" and returned
      // exports = {} (the empty-exports hole); post-fix it throws the cause.
      expect(() => movies!.evaluate()).toThrow(ModuleNotFoundError);
      expect(() => movies!.evaluate()).toThrow(/avatar\.jpg.*movies\.ts|movies\.ts.*avatar\.jpg/s);
    } finally {
      await h.teardown();
      restore();
    }
  });

  it('a never-compiled module (no error recorded) is refused too, naming the module', async () => {
    const restore = installEvalGlobals();
    const h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 'p', main: 'src/main' }),
      'src/main.ts': 'export default 1;\n',
    });
    try {
      await h.bundler.initPreset('create-react-app');
      // A module registered but never transformed (constructed directly) has
      // neither compiled nor compilationError — the guard's second arm.
      const { Module } = await import('./module/Module');
      const orphan = new Module(underAppRoot('/src/never-transformed.ts'), 'x', false, h.bundler);
      expect(() => orphan.evaluate()).toThrow(/never-transformed/);
      expect(() => orphan.evaluate()).toThrow(/never compiled/);
    } finally {
      await h.teardown();
      restore();
    }
  });
});
