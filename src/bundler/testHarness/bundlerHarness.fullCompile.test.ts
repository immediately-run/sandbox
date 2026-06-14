import { createBundlerHarness, FULL_COMPILE_FIXTURE, type BundlerHarness } from './bundlerHarness';

// R3-48 G0-0 full-compile smoke: boot the real Bundler in-process and run the WHOLE
// `compile()` over the harness fs — the booted-bundler harness's compile capability
// that G0-4's [harness] criteria (zero-Port-traffic, lazy-fetch, warm-boot, HMR,
// edit-racing) build on. The bundler transpiles via the in-process babel loopback and
// reads `/app` through the recorded stand-in (the Port-traffic spy); the platform SDK
// vendoring + react-refresh HMR runtime are stubbed (network/evaluate concerns, out of
// scope for an FS-routing/transpile compile). One compile in `beforeAll` (the babel
// loopback is one-per-file).
describe('G0-0 bundler full compile() smoke (booted bundler + babel loopback)', () => {
  let h: BundlerHarness;
  let evaluate: unknown;
  let appReads: string[];

  beforeAll(async () => {
    h = await createBundlerHarness(FULL_COMPILE_FIXTURE, { forCompile: true });
    h.resetSpies();
    evaluate = await h.bundler.compile();
    appReads = h.portOps.map((op) => op.path);
  }, 60000);

  afterAll(async () => {
    await h.teardown();
  });

  it('compile() resolves end-to-end and yields an evaluate callback', () => {
    expect(typeof evaluate).toBe('function');
  });

  it('read the entry (src/main) + its local import from /app over the Port-traffic spy', () => {
    expect(appReads.some((p) => p.endsWith('main.ts'))).toBe(true);
    expect(appReads.some((p) => p.endsWith('answer.ts'))).toBe(true);
  });

  it('reports the transpiled module graph (incl. the entry) via sendMessage("state")', () => {
    const state = h.sentMessages.find((m) => m.type === 'state')?.data as
      | { state?: { transpiledModules?: Record<string, unknown> } }
      | undefined;
    const modules = state?.state?.transpiledModules ?? {};
    expect(Object.keys(modules).some((k) => k.includes('main.ts'))).toBe(true);
  });
});
