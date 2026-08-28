// R3-426 row 2 (the exit criterion) — the Emscripten/wasm-pack loader idiom, composed
// through the REAL booted bundler:
//
//   const wasmUrl = new URL('./add.wasm', import.meta.url);   // R3-328 shim resolves it
//   WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer())
//   WebAssembly.instantiateStreaming(fetch(wasmUrl.href))     // needs application/wasm
//
// `import.meta.url` is the module's own module-space URL (origin + bundler filepath),
// so the sibling resolves BESIDE it — and the evaluator's per-module fetch shadow
// (moduleSpaceFetch.ts) serves that URL from the mounted app tree with the right MIME.
// The proof EXECUTES the wasm: add(2, 3) === 5 from inside the evaluated module graph.
//
// (One file per booted harness: the babel loopback is one-per-module-realm — the
// row-1 asset-import proof lives in bundlerHarness.wasmAsset.test.ts.)
import { createBundlerHarness, installEvalGlobals, type BundlerHarness } from './bundlerHarness';
import { WASM_ADD } from './wasmFixture';

// The loader shape, verbatim: resolve a SIBLING .wasm off import.meta.url, fetch it,
// instantiate — plus the streaming variant.
const WASM_LOADER_FIXTURE: Record<string, string | Uint8Array> = {
  'package.json': JSON.stringify({ name: 'wasm-loader-fixture', main: 'src/main' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/main.ts':
    "const wasmUrl = new URL('./add.wasm', import.meta.url);\n" +
    'const g = globalThis as Record<string, unknown>;\n' +
    'g.__wasmUrlHref = wasmUrl.href;\n' +
    'g.__wasmAdd = (async () => {\n' +
    '  const resp = await fetch(wasmUrl);\n' +
    '  const bytes = await resp.arrayBuffer();\n' +
    '  const result = await WebAssembly.instantiate(bytes);\n' +
    '  const exports = result.instance.exports as { add(a: number, b: number): number };\n' +
    '  return exports.add(2, 3);\n' +
    '})();\n' +
    'g.__wasmAddStreamed = (async () => {\n' +
    '  const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl.href));\n' +
    '  const exports = result.instance.exports as { add(a: number, b: number): number };\n' +
    '  return exports.add(2, 3);\n' +
    '})();\n' +
    'export default 1;\n',
  'src/add.wasm': WASM_ADD,
};

const testGlobals = globalThis as Record<string, unknown>;

describe('R3-426 row 2 — new URL(sibling.wasm, import.meta.url) loads through module-space fetch', () => {
  let h: BundlerHarness;
  let restore: () => void;

  beforeAll(async () => {
    restore = installEvalGlobals();
    h = await createBundlerHarness(WASM_LOADER_FIXTURE, { forCompile: true });
    const evaluate = await h.bundler.compile();
    (evaluate as () => unknown)();
  }, 60000);

  afterAll(async () => {
    delete testGlobals.__wasmUrlHref;
    delete testGlobals.__wasmAdd;
    delete testGlobals.__wasmAddStreamed;
    await h.teardown();
    restore();
  });

  it('import.meta.url resolves the sibling into the module space', () => {
    // installEvalGlobals pins location.origin to http://localhost; the module's own URL
    // is origin + its bundler filepath, so the sibling resolves beside it.
    expect(testGlobals.__wasmUrlHref).toBe('http://localhost/app/src/add.wasm');
  });

  it('fetch(wasmUrl) + instantiate executes the sibling wasm (add(2,3) === 5)', async () => {
    await expect(testGlobals.__wasmAdd).resolves.toBe(5);
  });

  it('instantiateStreaming(fetch(href)) works too — the shadow serves application/wasm', async () => {
    await expect(testGlobals.__wasmAddStreamed).resolves.toBe(5);
  });
});
