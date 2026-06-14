import { WorkerMessageBus } from '../../utils/WorkerMessageBus';

import { createBabelLoopback, type BabelLoopback } from './babelLoopback';

// Drive the in-process babel loopback exactly as the bundler's `BabelTransformer`
// does — a `WorkerMessageBus` over the returned port, requesting `transform`. Proves
// the harness can transpile real TS/TSX in jest (the missing piece for the
// `bundler.compile()` smoke), through the REAL `babel-worker` + `@babel/standalone`.
describe('G0-0 babel loopback (in-process babel worker)', () => {
  let loopback: BabelLoopback;
  let client: WorkerMessageBus;

  beforeAll(async () => {
    loopback = await createBabelLoopback();
    client = new WorkerMessageBus({
      channel: 'sandpack-babel',
      endpoint: loopback.babelPort,
      handleNotification: () => Promise.resolve(),
      handleRequest: () => Promise.reject(new Error('no requests')),
      handleError: () => Promise.resolve(),
      timeoutMs: 30000,
    });
  });
  afterAll(() => loopback.dispose());

  const transform = (code: string, filepath: string, config: unknown) =>
    client.request('transform', { code, filepath, config }) as Promise<{ code: string; dependencies: Set<string> }>;

  it('strips TypeScript types and reports a CommonJS module', async () => {
    const out = await transform('const x: number = 1;\nexport default x;\n', '/app/x.ts', { presets: [], plugins: [] });
    expect(typeof out.code).toBe('string');
    expect(out.code).not.toContain(': number'); // type annotation stripped
    expect(out.code).toContain('exports'); // transpiled to CJS
  }, 30000);

  it('transpiles TSX/JSX (the react preset path the compile smoke needs)', async () => {
    const out = await transform(
      "export default function App() {\n  return <h1>hi</h1>;\n}\n",
      '/app/App.tsx',
      { presets: ['react'], plugins: [] },
    );
    expect(out.code).toMatch(/jsx|createElement/); // JSX lowered, not left as <h1>
    expect(out.code).not.toContain('<h1>');
  }, 30000);

  it('collects dependencies from import/require', async () => {
    const out = await transform("import x from './dep';\nexport default x;\n", '/app/y.ts', { presets: [], plugins: [] });
    expect(Array.from(out.dependencies)).toContain('./dep');
  }, 30000);
});
