// R3-900 — fail-soft half: a transpile-cache write that fails is a missed cache
// entry. The module the bundler ALREADY holds is the result and still loads; one
// warning is logged with the path and the error code. (Its own file: the
// in-process babel loopback is one-per-file — see artifactWriteThrough.test.ts.)

import { createBundlerHarness, type BundlerHarness } from '../testHarness/bundlerHarness';

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'r3900-soft', main: 'src/only.ts' }),
  'src/only.ts': `export const answer: number = 42;\n`,
};

describe('R3-900: a rejected cache write never costs the compile', () => {
  let h: BundlerHarness;
  afterEach(() => h?.teardown());

  it('with fs.writeFile rejecting, the module still loads and one warning is logged with path and code', async () => {
    h = await createBundlerHarness(FIXTURE, { forCompile: true });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest
      .spyOn(h.bundler.fs, 'writeFile')
      .mockRejectedValueOnce(Object.assign(new Error('File exists'), { code: 'EEXIST' }));

    const mod = await h.bundler.transformModule('/app/src/only.ts');
    // The compile result survives the cache failure.
    expect(mod.compilationError).toBeNull();
    expect(mod.compiled).toContain('answer');

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain('/app/src/only.ts');
    expect(line).toContain('EEXIST');
    warn.mockRestore();
  });
});
