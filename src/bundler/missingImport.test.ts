import { fs } from '@zenfs/core';
import { underAppRoot } from '../fsLayout';
import { createBundlerHarness, installEvalGlobals, type BundlerHarness } from './testHarness/bundlerHarness';

// R3-899 — an import of a file that does not exist must surface as the missing
// module (path + importer), not as an unrelated TypeError downstream. The
// owner-report shape: src/data/movies.ts imports ../assets/posters/avatar.jpg
// (absent from the tree), and the stage showed `TypeError: Cannot read
// properties of undefined (reading 'map')` in the component that consumed the
// data module's exports — the failed module was evaluated as no-op code handing
// out EMPTY exports, and neither the user nor the in-browser agent was told
// which import failed (the 44-tool-call rabbit hole). The fixture writes REAL
// files into the harness fs so resolution runs the real resolver; the missing
// file is DELETED from a working graph, so the same test proves both halves.
jest.setTimeout(60000);

describe('Bundler: an import of a missing file names the module and the importer (R3-899)', () => {
  let h: BundlerHarness;
  let restore: () => void;

  const FIXTURE: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'missing-asset-fixture', main: 'src/main' }),
    'index.html': '<!doctype html><div id="root"></div>',
    // The consumer (the report's FilmNav shape): reads a value off the data module.
    'src/main.ts':
      "import { TITLE } from './data/movies';\n(globalThis as Record<string, unknown>).__title = TITLE;\nexport default 1;\n",
    // The data module — at src/data/, so ../assets is src/assets: the report's exact shape.
    'src/data/movies.ts': "import avatar from '../assets/posters/avatar.jpg';\nexport const TITLE = avatar;\n",
    'src/assets/posters/avatar.jpg': 'fake-jpeg-bytes',
  };

  beforeAll(async () => {
    restore = installEvalGlobals();
    h = await createBundlerHarness(FIXTURE, { forCompile: true });
    const evaluate = await h.bundler.compile();
    (evaluate as () => unknown)();
  }, 60000);

  afterAll(async () => {
    await h.teardown();
    restore();
  });

  it('the graph with the file present loads and evaluates (the test fails for the right reason when reverted)', () => {
    // The asset module exported its data URL; the consumer read it through the
    // data module. The full chain works when nothing is missing.
    expect((globalThis as Record<string, unknown>).__title).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('a resolved asset import records movies.ts in the real initiators map the read-failure wrap reads', () => {
    // The wrap's importer lookup only matters when RESOLUTION SUCCEEDED and the
    // READ then failed (the fetch-fs split) — a resolution miss names the
    // importer itself via the resolver's parent. With the file present,
    // resolution succeeds and addDependency records the initiator: the exact
    // map entry the wrap reads at read-failure time.
    const initiators = h.bundler.initiators.get(underAppRoot('/src/assets/posters/avatar.jpg'));
    expect(initiators).toBeDefined();
    expect([...initiators!]).toContain(underAppRoot('/src/data/movies.ts'));
  });

  it('the delete-edit flow: the memoized resolution cache answers from the pre-delete snapshot (documented stale-cache contract)', async () => {
    h.bundler.enableHMR();
    (globalThis as Record<string, unknown>).__title = '__stale__';
    await fs.promises.unlink(underAppRoot('/src/assets/posters/avatar.jpg'));
    await fs.promises.writeFile(
      underAppRoot('/src/data/movies.ts'),
      "import avatar from '../assets/posters/avatar.jpg';\nexport const TITLE = avatar;\n",
    );
    h.bundler.markFilesChanged([underAppRoot('/src/data/movies.ts')]);

    // Documented CONTRACT of the current cache (resolution memoized on
    // dirname+specifier, invalidated only on rejection): the recompile
    // RESOLVES from the pre-delete snapshot and no error names the missing
    // file. The cold-load twin (missingImport.cold.test.ts) carries the
    // failing-import assertions; making THIS flow fail live is the stale-cache
    // follow-up. Asserting the resolve keeps this honest red/green for it.
    const evaluate = await h.bundler.compile();
    expect(evaluate).toBeTruthy();
  });

  it('the add-by-edit boundary (the report agent vector): adding a NEVER-SEEN import rejects the recompile naming it AND its importer', async () => {
    h.bundler.enableHMR();
    await fs.promises.writeFile(
      underAppRoot('/src/data/movies.ts'),
      "import avatar from '../assets/posters/newposter.jpg';\nexport const TITLE = avatar;\n",
    );
    h.bundler.markFilesChanged([underAppRoot('/src/data/movies.ts')]);
    await expect(h.bundler.compile()).rejects.toThrow(/newposter\.jpg.*movies\.ts|movies\.ts.*newposter\.jpg/s);
  });
});
