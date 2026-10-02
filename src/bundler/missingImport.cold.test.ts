import { createBundlerHarness, installEvalGlobals } from './testHarness/bundlerHarness';

// R3-899, the COLD-LOAD half — the owner report's exact scenario: the agent
// wrote the import and never created the file, so the FIRST compile meets a
// graph with a dangling asset import. That compile must fail with the missing
// path AND its importer (ModuleNotFoundError's own message), never produce a
// bootable bundle whose failed module hands out empty exports.
jest.setTimeout(60000);

describe('Bundler: a cold load over a dangling import fails naming the module and importer (R3-899)', () => {
  it('compile() rejects with ModuleNotFoundError naming avatar.jpg AND movies.ts', async () => {
    const restore = installEvalGlobals();
    const h = await createBundlerHarness(
      {
        'package.json': JSON.stringify({ name: 'missing-asset-fixture', main: 'src/main' }),
        'index.html': '<!doctype html><div id="root"></div>',
        'src/main.ts':
          "import { TITLE } from './data/movies';\n(globalThis as Record<string, unknown>).__title = TITLE;\nexport default 1;\n",
        // avatar.jpg deliberately absent — the dangling import.
        'src/data/movies.ts': "import avatar from '../assets/posters/avatar.jpg';\nexport const TITLE = avatar;\n",
      },
      { forCompile: true },
    );
    try {
      await h.bundler.compile();
      throw new Error('compile resolved over a dangling import — the empty-exports hole');
    } catch (err) {
      expect((err as Error).message).toMatch(/avatar\.jpg/);
      expect((err as Error).message).toMatch(/movies\.ts/);
    } finally {
      await h.teardown();
      restore();
    }
  });
});
