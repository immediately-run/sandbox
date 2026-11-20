import { Bundler } from '../bundler';
import { installEvalGlobals } from '../testHarness/bundlerHarness';
import { Module } from './Module';

// An evaluated dependency used to be held up to three times: its source, its compiled
// output and the wrapped copy `eval` keeps as the script source. The first two have no
// reader once the module has run, so `evaluate()` drops them — for `/node_modules` only,
// because an app module is still mapped by the error overlay and re-run by hot reload.
describe('Module — text released after evaluation', () => {
  let restore: () => void;
  const modules = new Map<string, Module>();
  const bundler = {
    evaluationStack: [] as string[],
    modules,
    getModule: (id: string) => modules.get(id),
    getInitiators: () => new Set<string>(),
  } as unknown as Bundler;
  const precompiled = (path: string, code: string): Module => {
    const module = new Module(path, code, true, bundler);
    modules.set(path, module);
    return module;
  };

  beforeAll(() => {
    restore = installEvalGlobals();
  });
  afterAll(() => restore());
  beforeEach(() => modules.clear());

  it("drops a dependency module's source and compiled text, and keeps it compiled", () => {
    const dep = precompiled('/node_modules/leftpad/index.js', 'module.exports = { pad: 7 };');

    expect(dep.evaluate().context.exports).toEqual({ pad: 7 });

    expect(dep.compiled).toBeNull();
    expect(dep.source).toBe('');
    // Still compiled: every "is this module ready" check asks this, not `compiled`.
    expect(dep.isCompiled).toBe(true);
  });

  it('serves the cached evaluation afterwards — the released text is never needed again', () => {
    const dep = precompiled('/node_modules/leftpad/index.js', 'module.exports = { n: Math.random() };');
    const first = dep.evaluate();

    expect(dep.evaluate()).toBe(first);
    expect(dep.evaluate().context.exports).toBe(first.context.exports);
  });

  it('does not recompile a released module (compile() is a no-op once compiled)', async () => {
    const dep = precompiled('/node_modules/leftpad/index.js', 'module.exports = 1;');
    dep.evaluate();

    await dep.compile(); // would record "Preset has not been initialized" if it tried

    expect(dep.compilationError).toBeNull();
    expect(dep.isCompiled).toBe(true);
  });

  it("keeps an app module's text — the overlay maps its frames and hot reload re-runs it", () => {
    const code = 'module.exports = { app: true };';
    const app = precompiled('/app/src/main.js', code);

    app.evaluate();

    expect(app.compiled).toBe(code);
    expect(app.source).toBe(code);
  });

  it('keeps the text when evaluation throws, so the failure can still be reported', () => {
    const code = "throw new Error('boom');";
    const dep = precompiled('/node_modules/broken/index.js', code);

    expect(() => dep.evaluate()).toThrow('boom');

    expect(dep.compiled).toBe(code);
    expect(dep.evaluation).toBeNull();
  });
});
