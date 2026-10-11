import { createBundlerHarness, installEvalGlobals } from './testHarness/bundlerHarness';
import { ModuleNotFoundError } from '../errors/ModuleNotFound';

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
      // The item's Tests contract: the load rejects with a ModuleNotFoundError
      // (the ONE shape) whose message names both files.
      expect(err).toBeInstanceOf(ModuleNotFoundError);
      expect((err as Error).message).toMatch(/avatar\.jpg/);
      expect((err as Error).message).toMatch(/movies\.ts/);
    } finally {
      await h.teardown();
      restore();
    }
  });
});

// R3-899 round 1 — the asset READ-failure arm (the fetch-fs split: the tree
// index says present, the bytes 404), driven at the transformer directly with
// a stub bundler whose read rejects (the full-compile spy breaks the babel
// loopback, which shares the bound context): the wrap must fail as the ONE
// error shape with BOTH names — the asset and its importer (from the bundler's
// own initiators map, the same place addDependency records it).
import { AssetTransformer } from './transforms/asset';

describe('R3-899 — the asset read-failure wrap (one shape, both names)', () => {
  it('a rejecting read throws ModuleNotFoundError naming the asset AND its importer', async () => {
    const t = new AssetTransformer();
    await t.init({
      initiators: new Map([['/app/src/assets/posters/avatar.jpg', new Set(['/app/src/data/movies.ts'])]]),
      fs: {
        boundContext: {
          fs: {
            promises: {
              readFile: async () => {
                throw Object.assign(
                  new Error("ENOENT: no such file or directory, open '/app/src/assets/posters/avatar.jpg'"),
                  { code: 'ENOENT' },
                );
              },
            },
          },
        },
      },
    } as never);
    // The transformer touches ctx.module.filepath only — the stub carries the
    // asset's own path; the importer arrives via the initiators map.
    const ctx = {
      module: { filepath: '/app/src/assets/posters/avatar.jpg' },
      code: '',
    };
    const err = await t.transform(ctx as never, {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ModuleNotFoundError);
    expect((err as Error).message).toContain('/app/src/assets/posters/avatar.jpg');
    expect((err as Error).message).toContain('/app/src/data/movies.ts');
  });
});
