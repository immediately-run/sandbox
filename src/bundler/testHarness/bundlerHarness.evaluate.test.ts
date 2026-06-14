import { fs } from '@zenfs/core';

import { underAppRoot } from '../../fsLayout';
import { createBundlerHarness, EVAL_FIXTURE, installEvalGlobals, type BundlerHarness } from './bundlerHarness';

// R3-48 G0-0 evaluate smoke: the booted bundler not only COMPILES but EVALUATES the
// graph in-process — the entry executes and resolves its import (asserted via a global
// side effect). Then an edit (re-write a module + markFilesChanged + recompile) is
// picked up: the changed module is re-read from `/app` and re-transpiled. This is the
// evaluate/edit-racing layer the G0-4 HMR-parity [harness] rows build on.
describe('G0-0 bundler evaluate smoke (run the compiled graph + edit pickup)', () => {
  let h: BundlerHarness;
  let restore: () => void;

  beforeAll(async () => {
    restore = installEvalGlobals();
    h = await createBundlerHarness(EVAL_FIXTURE, { forCompile: true });
    const evaluate = await h.bundler.compile();
    (evaluate as () => unknown)(); // first-load: runs runtimes + the entry
  }, 60000);

  afterAll(async () => {
    await h.teardown();
    restore();
  });

  it('executes the compiled entry (and resolves its import) at evaluate time', () => {
    // `src/main` did `globalThis.__evalResult = answer + 1` (answer = 41).
    expect((globalThis as Record<string, unknown>).__evalResult).toBe(42);
  });

  it('picks up an edit on recompile — the changed module is re-read + re-transpiled', async () => {
    // Without HMR an edit triggers a full page reload (not an incremental
    // re-transpile); a real app enables HMR by registering `module.hot`, so do the
    // same here to exercise the incremental edit path.
    h.bundler.enableHMR();
    await fs.promises.writeFile(
      underAppRoot('/src/answer.ts'),
      'const answer: number = 99;\nexport default answer;\n',
    );
    h.bundler.markFilesChanged([underAppRoot('/src/answer.ts')]);
    h.sentMessages.length = 0;

    await h.bundler.compile();

    const state = h.sentMessages.find((m) => m.type === 'state')?.data as
      | { state?: { transpiledModules?: Record<string, { source?: { compiledCode?: string } }> } }
      | undefined;
    const mods = state?.state?.transpiledModules ?? {};
    const answerModule = Object.entries(mods).find(([k]) => k.includes('answer.ts'))?.[1];
    expect(answerModule?.source?.compiledCode).toContain('99'); // the edit was picked up
  }, 60000);
});
