import { fs } from '@zenfs/core';

import { underAppRoot } from '../../fsLayout';
import { createBundlerHarness, EVAL_FIXTURE, installEvalGlobals, type BundlerHarness } from './bundlerHarness';

// R3-48 G0-4 [harness] proofs for the edit/reload behavior over the flipped mount table
// (plan 02-zenfs-unification.md exit map). Complements `bundlerHarness.evaluate.test.ts`
// (the seeded-module edit-pickup / HMR-parity row). Covered here:
//   - a package.json no-op rewrite does NOT reload (the `_previousDepString` loop guard)
//   - without HMR a real edit triggers a full page reload (the reload-vs-HMR parity)
//   - rapid successive edits racing a single recompile are not lost — the LATEST bytes
//     are re-read + re-transpiled (the "edit racing boot not lost" row)
//
// The in-process babel loopback is ONE-per-test-file (the worker's connect handshake
// self-removes), so a single harness + first compile is shared in `beforeAll` and the
// tests run in order over it (mirrors evaluate/compile/fullCompile harness suites).
// `compile()` reads the edited modules from `/app` (the Port stand-in) and the runtimes
// from the bundler-owned `/node_modules` mount, so these exercise the full flipped path.

/** Pull a transpiled module's compiled code out of the `state` message the bundler emits. */
function compiledCodeFor(h: BundlerHarness, needle: string): string | undefined {
  const state = h.sentMessages.find((m) => m.type === 'state')?.data as
    | { state?: { transpiledModules?: Record<string, { source?: { compiledCode?: string } }> } }
    | undefined;
  const mods = state?.state?.transpiledModules ?? {};
  return Object.entries(mods).find(([k]) => k.includes(needle))?.[1]?.source?.compiledCode;
}

describe('G0-4 [harness] edit/reload behavior over the flipped mount table', () => {
  let h: BundlerHarness;
  let restore: () => void;
  let reloadSpy: jest.Mock;

  beforeAll(async () => {
    restore = installEvalGlobals();
    reloadSpy = jest.fn();
    (globalThis as unknown as { location: { reload: () => void } }).location.reload = reloadSpy;
    h = await createBundlerHarness(EVAL_FIXTURE, { forCompile: true });
    const evaluate = await h.bundler.compile(); // first load
    (evaluate as () => unknown)();
  }, 60000);

  afterAll(async () => {
    await h.teardown();
    restore();
  });

  // Run FIRST, while HMR is off and deps are unchanged — a no-op rewrite of the same
  // package.json the parent's addPackageJSONIfNeeded re-issues on every handshake. An
  // unguarded no-op would loop: fs-change → reload → handshake → rewrite → … It is
  // exempt from the HMR-reload check, and same deps → no dep reload.
  it('a package.json no-op rewrite does NOT reload (the _previousDepString loop guard)', async () => {
    await fs.promises.writeFile(underAppRoot('/package.json'), EVAL_FIXTURE['package.json']);
    h.bundler.markFilesChanged([underAppRoot('/package.json')]);
    reloadSpy.mockClear();

    await h.bundler.compile();

    expect(reloadSpy).not.toHaveBeenCalled();
  }, 60000);

  it('without HMR, a real edit triggers a full page reload (parity baseline)', async () => {
    // No `enableHMR()` yet — a non-package.json change with no HMR falls back to a reload
    // (returns before any transform, so no babel here).
    await fs.promises.writeFile(
      underAppRoot('/src/answer.ts'),
      'const answer: number = 8;\nexport default answer;\n',
    );
    h.bundler.markFilesChanged([underAppRoot('/src/answer.ts')]);
    reloadSpy.mockClear();

    await h.bundler.compile();

    expect(reloadSpy).toHaveBeenCalled();
  }, 60000);

  it('rapid successive edits before one recompile are not lost — the latest is re-transpiled', async () => {
    h.bundler.enableHMR();

    // Two edits queued back-to-back before the recompile drains them: the change queue
    // must retain the racing edit, and the recompile must re-read the LATEST bytes from
    // `/app` (the Port stand-in) — not a stale snapshot, and not drop the second write.
    await fs.promises.writeFile(
      underAppRoot('/src/answer.ts'),
      'const answer: number = 55;\nexport default answer;\n',
    );
    h.bundler.markFilesChanged([underAppRoot('/src/answer.ts')]);
    await fs.promises.writeFile(
      underAppRoot('/src/answer.ts'),
      'const answer: number = 77;\nexport default answer;\n',
    );
    h.bundler.markFilesChanged([underAppRoot('/src/answer.ts')]);
    h.sentMessages.length = 0;

    await h.bundler.compile();

    const compiled = compiledCodeFor(h, 'answer.ts');
    expect(compiled).toContain('77'); // the latest edit won
    expect(compiled).not.toContain('55'); // the superseded edit did not leak through
  }, 60000);
});
