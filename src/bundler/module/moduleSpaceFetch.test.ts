// R3-426 — the module-space fetch shadow, unit half: URLs inside this origin's module
// space that name a real bundler-fs file are served from its bytes (correct MIME —
// `application/wasm` verbatim for `.wasm`, which `instantiateStreaming` requires);
// everything else falls through to the native fetch untouched. The composed
// bundler-run proof lives in testHarness/bundlerHarness.wasm.test.ts.
import type { Bundler } from '../bundler';
import { createModuleSpaceFetch, moduleSpacePathOf } from './moduleSpaceFetch';

/** The canonical two-i32 `add` module (all bytes ASCII-range; add(2,3) === 5). */
const WASM_ADD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1,
  7, 0, 32, 0, 32, 1, 106, 11,
]);

const ORIGIN = 'http://localhost';

function stubBundler(files: Record<string, Uint8Array>): Bundler {
  return {
    fs: {
      isFileAsync: async (p: string) => Object.prototype.hasOwnProperty.call(files, p),
      readBytesAsync: async (p: string) => files[p],
    },
  } as unknown as Bundler;
}

describe('module-space fetch shadow (R3-426)', () => {
  const g = globalThis as Record<string, unknown>;
  let prevLocation: unknown;
  let prevFetch: unknown;
  let nativeCalls: unknown[];

  beforeEach(() => {
    prevLocation = g.location;
    prevFetch = g.fetch;
    nativeCalls = [];
    g.location = { origin: ORIGIN, href: `${ORIGIN}/` };
    g.fetch = (...args: unknown[]) => {
      nativeCalls.push(args);
      return Promise.resolve(new Response('native', { status: 299 }));
    };
  });

  afterEach(() => {
    g.location = prevLocation;
    g.fetch = prevFetch;
  });

  it('serves a module-space .wasm from the bundler fs with application/wasm', async () => {
    const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
    const resp = await fetchShadow(`${ORIGIN}/app/src/add.wasm`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('application/wasm');
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(WASM_ADD);
    expect(nativeCalls).toHaveLength(0);
  });

  it('the served response instantiates streaming — the MIME contract holds end to end', async () => {
    const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
    const { instance } = await WebAssembly.instantiateStreaming(fetchShadow(`${ORIGIN}/app/src/add.wasm`));
    expect((instance.exports as { add(a: number, b: number): number }).add(2, 3)).toBe(5);
  });

  it('accepts URL objects (the new URL(rel, import.meta.url) shape) and Request-likes', async () => {
    const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
    const viaUrl = await fetchShadow(new URL('./add.wasm', `${ORIGIN}/app/src/main.ts`));
    expect(viaUrl.status).toBe(200);
    const viaRequest = await fetchShadow(new Request(`${ORIGIN}/app/src/add.wasm`));
    expect(viaRequest.status).toBe(200);
    expect(nativeCalls).toHaveLength(0);
  });

  it('a non-asset module-space file is served as octet-stream (honest bytes)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/model.bin': bytes }));
    const resp = await fetchShadow(`${ORIGIN}/app/src/model.bin`);
    expect(resp.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(bytes);
  });

  it('HEAD is served with an empty body; other methods fall through', async () => {
    const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
    const head = await fetchShadow(`${ORIGIN}/app/src/add.wasm`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const post = await fetchShadow(`${ORIGIN}/app/src/add.wasm`, { method: 'POST' });
    expect(post.status).toBe(299); // the native double answered
    expect(nativeCalls).toHaveLength(1);
  });

  it('falls through for other origins and for module-space paths with no backing file', async () => {
    const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
    const crossOrigin = await fetchShadow('https://example.com/app/src/add.wasm');
    expect(crossOrigin.status).toBe(299);
    const missing = await fetchShadow(`${ORIGIN}/app/src/absent.wasm`);
    expect(missing.status).toBe(299);
    const outsideModuleSpace = await fetchShadow(`${ORIGIN}/api/data`);
    expect(outsideModuleSpace.status).toBe(299);
    expect(nativeCalls).toHaveLength(3);
  });

  it('moduleSpacePathOf resolves relative URLs against the frame location', () => {
    expect(moduleSpacePathOf('/app/src/add.wasm')).toBe('/app/src/add.wasm');
    expect(moduleSpacePathOf(`${ORIGIN}/app/a%20b.wasm`)).toBe('/app/a b.wasm');
    expect(moduleSpacePathOf('https://example.com/app/x.wasm')).toBeNull();
    expect(moduleSpacePathOf(`${ORIGIN}/other/x.wasm`)).toBeNull();
  });
});
