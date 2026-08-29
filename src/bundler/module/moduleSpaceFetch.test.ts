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

  // R3-426 (review): `decodeURIComponent` ran AFTER the `/app/` prefix check, and the
  // URL parser does not normalize `%2F` — so an encoded-traversal URL passed the
  // containment check and only then decoded into a path OUTSIDE the module space the
  // shadow exists to bound.
  describe('containment: encoded traversal cannot escape the module space', () => {
    const escapes = [
      // The reported shape: encoded slashes, undetected by the URL parser.
      '/app/x/..%2F..%2Fnode_modules/react/index.js',
      // Lower-case escape, and mixed case in one URL.
      '/app/x/..%2f..%2fnode_modules/react/index.js',
      '/app/x/..%2F..%2fnode_modules/react/index.js',
      // Encoded dots instead of encoded slashes.
      '/app/%2e%2e/%2e%2e/node_modules/react/index.js',
      '/app/%2E%2E/%2E%2E/node_modules/react/index.js',
      // Both halves encoded.
      '/app/%2e%2e%2f%2e%2e%2fnode_modules/react/index.js',
      // Plain (unencoded) traversal, for completeness.
      '/app/../node_modules/react/index.js',
      // Sideways out of /app/ into a sibling root.
      '/app/..%2Fapp2/secret.js',
    ];

    it.each(escapes)('refuses %s', (path) => {
      expect(moduleSpacePathOf(`${ORIGIN}${path}`)).toBeNull();
    });

    it('never hands the fs a path outside /app/ (the fetch half)', async () => {
      const probed: string[] = [];
      const bundler = {
        fs: {
          isFileAsync: async (p: string) => {
            probed.push(p);
            return true;
          },
          readBytesAsync: async () => new Uint8Array([1]),
        },
      } as unknown as Bundler;
      const fetchShadow = createModuleSpaceFetch(bundler);
      for (const path of escapes) {
        const resp = await fetchShadow(`${ORIGIN}${path}`);
        expect(resp.status).toBe(299); // fell through to the native double
      }
      expect(probed).toEqual([]);
    });

    it('double-encoding decodes exactly once and stays inside the module space', () => {
      // `%252F` is a file literally named with a `%2F` in it, not a separator: one
      // decode leaves `%2F` as ordinary characters of a single path segment.
      expect(moduleSpacePathOf(`${ORIGIN}/app/x/..%252F..%252Fnode_modules/y.js`)).toBe(
        '/app/x/..%2F..%2Fnode_modules/y.js',
      );
    });

    it('malformed percent-escapes are not a module-space path', () => {
      expect(moduleSpacePathOf(`${ORIGIN}/app/%E0%A4%A.wasm`)).toBeNull();
    });

    it('legitimate encoded characters in real filenames still resolve', async () => {
      const bytes = new Uint8Array([7, 7, 7]);
      const files = {
        '/app/src/a b.wasm': bytes,
        '/app/src/hello (1)+#.wasm': bytes,
        '/app/src/caf\u00e9.wasm': bytes,
      };
      expect(moduleSpacePathOf(`${ORIGIN}/app/src/a%20b.wasm`)).toBe('/app/src/a b.wasm');
      expect(moduleSpacePathOf(`${ORIGIN}/app/src/hello%20(1)%2B%23.wasm`)).toBe('/app/src/hello (1)+#.wasm');
      expect(moduleSpacePathOf(`${ORIGIN}/app/src/caf%C3%A9.wasm`)).toBe('/app/src/caf\u00e9.wasm');

      const fetchShadow = createModuleSpaceFetch(stubBundler(files));
      const resp = await fetchShadow(`${ORIGIN}/app/src/caf%C3%A9.wasm`);
      expect(resp.status).toBe(200);
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(bytes);
    });

    it('a `..` that stays inside the module space is still served', async () => {
      const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
      expect(moduleSpacePathOf(`${ORIGIN}/app/src/nested/..%2Fadd.wasm`)).toBe('/app/src/add.wasm');
      expect((await fetchShadow(`${ORIGIN}/app/src/nested/../add.wasm`)).status).toBe(200);
    });
  });

  // R3-426 (review): a module-space HIT ignored `init` entirely, so an AbortSignal
  // never aborted — the request resolved 200 instead of rejecting AbortError.
  describe('honours init.signal on a served hit', () => {
    it('rejects an already-aborted request without touching the fs', async () => {
      const probed: string[] = [];
      const bundler = {
        fs: {
          isFileAsync: async (p: string) => {
            probed.push(p);
            return true;
          },
          readBytesAsync: async () => WASM_ADD,
        },
      } as unknown as Bundler;
      const fetchShadow = createModuleSpaceFetch(bundler);
      const controller = new AbortController();
      controller.abort();
      await expect(fetchShadow(`${ORIGIN}/app/src/add.wasm`, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(probed).toEqual([]);
    });

    it('rejects a request aborted in flight', async () => {
      let releaseRead: () => void = () => {};
      const bundler = {
        fs: {
          isFileAsync: async () => true,
          readBytesAsync: () => new Promise<Uint8Array>((resolve) => (releaseRead = () => resolve(WASM_ADD))),
        },
      } as unknown as Bundler;
      const fetchShadow = createModuleSpaceFetch(bundler);
      const controller = new AbortController();
      const pending = fetchShadow(`${ORIGIN}/app/src/add.wasm`, { signal: controller.signal });
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await assertion;
      releaseRead(); // the read settles late; nothing observes it
    });

    it("takes the signal off a Request input too, and honours the signal's abort reason", async () => {
      const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
      const controller = new AbortController();
      controller.abort(new Error('caller went away'));
      const req = new Request(`${ORIGIN}/app/src/add.wasm`, { signal: controller.signal });
      await expect(fetchShadow(req)).rejects.toThrow('caller went away');
    });

    it('an un-aborted signal changes nothing', async () => {
      const fetchShadow = createModuleSpaceFetch(stubBundler({ '/app/src/add.wasm': WASM_ADD }));
      const controller = new AbortController();
      const resp = await fetchShadow(`${ORIGIN}/app/src/add.wasm`, { signal: controller.signal });
      expect(resp.status).toBe(200);
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(WASM_ADD);
    });
  });

  it('moduleSpacePathOf resolves relative URLs against the frame location', () => {
    expect(moduleSpacePathOf('/app/src/add.wasm')).toBe('/app/src/add.wasm');
    expect(moduleSpacePathOf(`${ORIGIN}/app/a%20b.wasm`)).toBe('/app/a b.wasm');
    expect(moduleSpacePathOf('https://example.com/app/x.wasm')).toBeNull();
    expect(moduleSpacePathOf(`${ORIGIN}/other/x.wasm`)).toBeNull();
  });
});
