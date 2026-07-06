import { underAppRoot } from '../fsLayout';
import { BundlerHarness, createBundlerHarness } from './testHarness/bundlerHarness';

// Regression (root-caused from the R3-146 live drill, 2026-07-06): when a module's
// SOURCE fails to load — almost always a failed fetch, e.g. a GitHub REST rate limit
// returning 403 (no CORS header) on a cache-cold load — the bundler MUST fail fast at
// the original load/transform with an HONEST message that names the file + the likely
// real cause. Before the fix, the failure was swallowed and only surfaced much later
// at require()/evaluate time as the misleading `Module "X" has not been transpiled`,
// which sends debugging down a transpile/mount rabbit hole when the real cause is a
// network/rate-limit fetch failure. (This is exactly what cost the R3-146 drill: a
// cache-cold local load rate-limited GitHub blob fetches → the confusing error.)
describe('Bundler: a failed source load fails fast + clearly, not a misleading require-time error', () => {
  let h: BundlerHarness;

  afterEach(async () => {
    await h?.teardown();
  });

  it('transformModule() rejects at LOAD time, naming the file + the likely fetch/rate-limit cause', async () => {
    h = await createBundlerHarness();
    await h.bundler.initPreset('create-react-app');

    // The file is resolvable, but its content read fails — the rate-limit scenario:
    // the tree/index says it exists, but the blob fetch that populates its content was
    // rejected (a 403 with no CORS header on a cache-cold load).
    const answer = underAppRoot('/src/answer.ts');
    const realRead = h.bundler.fs.readFileAsync.bind(h.bundler.fs);
    jest
      .spyOn(h.bundler.fs, 'readFileAsync')
      .mockImplementation(async (p: string) =>
        String(p).endsWith('/src/answer.ts') ? Promise.reject(new Error('403: API rate limit exceeded')) : realRead(p)
      );

    // Fails fast at the load/transform attempt…
    await expect(h.bundler.transformModule(answer)).rejects.toThrow(/failed to (load|re-read) source/i);
    // …names the offending file…
    await expect(h.bundler.transformModule(answer)).rejects.toThrow(/answer\.ts/);
    // …points at the real cause (a failed fetch / rate limit), not a transpiler bug…
    await expect(h.bundler.transformModule(answer)).rejects.toThrow(/rate limit|fetch|could not be read/i);
    // …and is NOT the misleading downstream message it used to degrade into.
    await expect(h.bundler.transformModule(answer)).rejects.not.toThrow(/has not been transpiled/i);
  });
});
