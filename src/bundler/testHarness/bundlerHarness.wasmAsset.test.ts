// R3-426 row 1 — `.wasm` as an importable asset, through the REAL booted bundler:
// `import wasmUrl from './add.wasm'` compiles (the asset transform maps
// `application/wasm`) and the exported data URL feeds BOTH loader patterns —
// `fetch(url).then(r => r.arrayBuffer())` + `WebAssembly.instantiate`, and
// `WebAssembly.instantiateStreaming(fetch(url))`, which requires the
// `application/wasm` Content-Type verbatim (a data: URL fetch preserves it).
// The proof EXECUTES the wasm: add(2, 3) === 5 from the emitted asset form.
//
// (One file per booted harness: the babel loopback is one-per-module-realm — the
// row-2 import.meta.url composition lives in bundlerHarness.wasmImportMeta.test.ts.)
import { createBundlerHarness, installEvalGlobals, type BundlerHarness } from './bundlerHarness';
import { WASM_ADD, type WasmAddExports } from './wasmFixture';

const WASM_ASSET_FIXTURE: Record<string, string | Uint8Array> = {
  'package.json': JSON.stringify({ name: 'wasm-asset-fixture', main: 'src/main' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/main.ts':
    "import wasmUrl from './add.wasm';\n" +
    '(globalThis as Record<string, unknown>).__wasmAssetUrl = wasmUrl;\n' +
    'export default 1;\n',
  'src/add.wasm': WASM_ADD,
};

const testGlobals = globalThis as Record<string, unknown>;

describe('R3-426 row 1 — .wasm asset import through the booted bundler', () => {
  let h: BundlerHarness;
  let restore: () => void;

  beforeAll(async () => {
    restore = installEvalGlobals();
    h = await createBundlerHarness(WASM_ASSET_FIXTURE, { forCompile: true });
    const evaluate = await h.bundler.compile();
    (evaluate as () => unknown)();
  }, 60000);

  afterAll(async () => {
    delete testGlobals.__wasmAssetUrl;
    await h.teardown();
    restore();
  });

  it('exports an application/wasm data URL', () => {
    expect(testGlobals.__wasmAssetUrl).toMatch(/^data:application\/wasm;base64,/);
  });

  it('the URL feeds fetch → arrayBuffer → instantiate (add(2,3) === 5)', async () => {
    const url = testGlobals.__wasmAssetUrl as string;
    const bytes = await (await fetch(url)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes);
    expect((instance.exports as unknown as WasmAddExports).add(2, 3)).toBe(5);
  });

  it('the URL feeds instantiateStreaming(fetch(url)) — the MIME survives the data URL', async () => {
    const url = testGlobals.__wasmAssetUrl as string;
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url));
    expect((instance.exports as unknown as WasmAddExports).add(2, 3)).toBe(5);
  });
});
