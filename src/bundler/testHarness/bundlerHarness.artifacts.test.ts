import { createBundlerHarness, EVAL_FIXTURE, installEvalGlobals, type BundlerHarness } from './bundlerHarness';

// R3-48 Gate 2 (G2-0) — the harness extension's own smoke: prove the babel-request
// spy is wired and observable, adding no production behavior. The spy is the
// instrument the G2-5 `[harness]` rows depend on — it counts every `transform`
// the bundler issues over the babel loopback, so a seeded boot can assert ZERO
// transforms for covered sources (spec §9) and an edit asserts exactly one. Here
// we only prove the spy COUNTS (a normal compile transforms the entry + its dep);
// the seeded-zero assertion lands with G2-5 (the `/transpiled` consult).
//
// (The artifact-seeding fixture writer + dirty-set/distrust doubles — the other
// pieces of the planned G2-0 — land with their consumers: the fixture writer
// reuses the G2-2 artifact-index module, and the dirty-set/distrust hooks have no
// bundler consumer until G2-4/G2-5/G2-6. Adding them now would be untestable
// scaffolding.)

describe('G2-0 babel-request spy (records transforms over the loopback)', () => {
  let h: BundlerHarness;
  let restore: () => void;

  beforeAll(async () => {
    restore = installEvalGlobals();
    h = await createBundlerHarness(EVAL_FIXTURE, { forCompile: true });
    h.babel.resetTransformRequests();
    await h.bundler.compile();
  }, 60000);

  afterAll(async () => {
    await h.teardown();
    restore();
  });

  it('records the entry + its local import as transform requests', () => {
    expect(h.babel.transformRequests.length).toBeGreaterThan(0);
    expect(h.babel.transformRequests.some((p) => p.endsWith('main.ts'))).toBe(true);
    expect(h.babel.transformRequests.some((p) => p.endsWith('answer.ts'))).toBe(true);
  });

  it('resetTransformRequests clears the recording', () => {
    h.babel.resetTransformRequests();
    expect(h.babel.transformRequests).toEqual([]);
  });
});
