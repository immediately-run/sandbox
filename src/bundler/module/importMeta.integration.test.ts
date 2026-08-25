// The cross-repo composition of the import.meta shim (R3-328) — possible only once the
// sandbox pins @immediately-run/transpiler ≥0.8.0: the REAL published transform rewrites
// the syntax, and the REAL evaluator provides the value. This is the seam the two
// half-tests could only pin separately: same identifier, and the emitted bytes actually
// evaluate through eval.ts with the injected global.
import { PLAIN_BABEL_CONFIG, transformBabel } from '@immediately-run/transpiler';

import evaluate from './eval';
import { IMPORT_META_GLOBAL, importMetaFor } from './importMeta';

describe('import.meta shim — transpiler(0.8.0) × sandbox evaluator, composed', () => {
  it('a module using import.meta transpiles and EVALUATES with its own URL', async () => {
    // The exact code shape that killed the reckoner demo at parse time.
    const source = `export const u = import.meta.url;\nmodule.exports = { url: import.meta.url };`;
    const { code } = await transformBabel({
      code: source,
      filepath: '/app/src/example.ts',
      config: PLAIN_BABEL_CONFIG,
    });

    expect(code).not.toMatch(/import\.meta/); // the parse-time SyntaxError is gone

    const url = 'https://sandbox.immediately.run/app/src/example.ts';
    const context: any = { id: '/app/src/example.ts', exports: {} };
    evaluate(code, () => ({}), context, {}, { [IMPORT_META_GLOBAL]: importMetaFor(url) });
    expect(context.exports.url).toBe(url);
  });

  it('the module-worker guard makes the shimmed worker idiom fail fast and catchably', async () => {
    // The second half of the reckoner shape: with the shim, the worker URL RESOLVES —
    // and constructing from it must throw synchronously so the app's catch engages.
    const { installModuleWorkerGuard } = await import('../../security/moduleWorkerGuard');
    const ORIGIN = 'https://sandbox.immediately.run';
    const { code } = await transformBabel({
      code: `new Worker(new URL('./engine.ts', import.meta.url), { type: 'module' });`,
      filepath: '/app/src/example.ts',
      config: PLAIN_BABEL_CONFIG,
    });
    expect(code).toContain(`${IMPORT_META_GLOBAL}.url`);

    // A native-Worker stand-in and its scope, exactly like the guard's unit test.
    class NativeWorker {
      constructed = false;
      constructor(_url?: unknown, _opts?: unknown) {
        this.constructed = true;
      }
    }
    const scope: any = { Worker: NativeWorker };
    installModuleWorkerGuard(scope, ORIGIN);
    let caught: unknown = null;
    try {
      const url = importMetaFor(`${ORIGIN}/app/src/example.ts`).url;
      const workerUrl = new URL('./engine.ts', url); // resolves exactly as the app's would
      new scope.Worker(workerUrl, { type: 'module' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/sandbox module space/);
  });
});
