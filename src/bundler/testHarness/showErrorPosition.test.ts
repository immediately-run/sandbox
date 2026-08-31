import { createBundlerHarness, COMPILE_FIXTURE } from './bundlerHarness';
import { errorMessage } from '../../errors/util';
import { underAppRoot } from '../../fsLayout';

/**
 * R3-434 pin — the compile-phase (transform/Babel) leg, end to end through the
 * REAL chain (harness fs → bundler → BabelTransformer → the in-process babel
 * loopback running the real `@immediately-run/transpiler`): a syntax error's
 * `show-error` MUST carry `path`/`line`/`column`, because the Babel error's
 * `loc` survives the worker transport (spread into the wire error) and
 * `CompilationError` reads it. The Tools panel files such a row under its file;
 * the drill that filed this item saw the "not file-located" bucket instead.
 */
describe('R3-434 — a Babel transform error carries its position on the wire', () => {
  it('a syntax error reaches show-error with path/line/column', async () => {
    const broken = {
      ...COMPILE_FIXTURE,
      'src/index.ts': 'const x = ;\nexport default x;\n',
    };
    const h = await createBundlerHarness(broken);
    await h.bundler.initPreset('create-react-app');

    let thrown: unknown;
    await h.bundler.transformModule(underAppRoot('/src/index.ts')).catch((e: unknown) => (thrown = e));
    await h.bundler.transformationQueue.onIdle().catch(() => undefined);
    const mod = (h.bundler as unknown as MapPropertyAccessor).modules?.get(underAppRoot('/src/index.ts'));
    const err = mod?.compilationError ?? thrown;
    expect(err).toBeDefined();

    const wire = errorMessage(err as never) as {
      action?: string;
      path?: string;
      line?: number;
      column?: number;
      message: string;
    };
    expect(wire.action).toBe('show-error');
    expect(wire.path).toBe(underAppRoot('/src/index.ts'));
    expect(wire.line).toBe(1);
    expect(wire.column).toBe(10);
    // The message keeps Babel's code frame verbatim — display data, unchanged.
    expect(wire.message).toContain('Unexpected token');

    await h.teardown();
  }, 60000);
});

interface MapPropertyAccessor {
  modules?: Map<string, { compilationError?: unknown }>;
}
