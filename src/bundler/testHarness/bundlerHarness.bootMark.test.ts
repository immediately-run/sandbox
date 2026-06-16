import { createBundlerHarness, EVAL_FIXTURE, type BundlerHarness } from './bundlerHarness';

// R3-46 LOAD_PROFILING_SPEC §3 phase 3: the bundler emits `ir.sandbox.boot` at the
// top of the FIRST compile — the earliest in-sandbox instant the message bus is live.
// Together with the existing `ir.deps`/`ir.transpile`/`ir.eval` marks this brackets
// the cold-boot stretch (iframe-ready → compile-prep + node-module load → deps).
describe('ir.sandbox.boot marker', () => {
  let h: BundlerHarness;

  beforeAll(async () => {
    h = await createBundlerHarness(EVAL_FIXTURE, { forCompile: true });
    await h.bundler.compile();
  }, 60000);

  afterAll(() => h.teardown());

  const irMarks = () =>
    h.sentMessages
      .filter((m) => m.type === 'ir-marker')
      .map((m) => (m.data as { name: string }).name);

  it('emits exactly one ir.sandbox.boot on the first compile, as a bare mark', () => {
    const boots = h.sentMessages.filter(
      (m) => m.type === 'ir-marker' && (m.data as { name: string }).name === 'ir.sandbox.boot',
    );
    expect(boots).toHaveLength(1);
    // Phase-3 boot is a bare mark (no attrs), per the §3 vocabulary table.
    expect(boots[0].data).not.toHaveProperty('attrs');
    expect(typeof (boots[0].data as { at: number }).at).toBe('number');
  });

  it('emits ir.sandbox.boot before ir.deps (it brackets the compile-prep phase)', () => {
    const names = irMarks();
    const bootIdx = names.indexOf('ir.sandbox.boot');
    const depsIdx = names.indexOf('ir.deps');
    expect(bootIdx).toBeGreaterThanOrEqual(0);
    expect(depsIdx).toBeGreaterThan(bootIdx);
  });
});
