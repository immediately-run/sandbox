/**
 * @jest-environment jsdom
 *
 * The origin bound on error-listener source fetches (R3-367 finding 3).
 *
 * The two cases that matter are the item's own adversarial exit criteria: a
 * stack naming `https://evil.example/x.map` must fetch NOTHING, and a legitimate
 * bundler-origin map must still load. Everything else here exists to stop the
 * bound being widened by accident.
 */
import { CDN_ROOT, ESM_ORIGIN, SELF_HOST_BASES, UNPKG_ROOT } from '../bundler/moduleOrigins';
import { MAX_SOURCE_BYTES, fetchSourceText, isAllowedSourceUrl } from './sourceOrigins';

// jsdom serves `http://localhost/` as the document origin.
const HERE = 'http://localhost/app/index.js';

describe('isAllowedSourceUrl', () => {
  it('REFUSES the adversarial case: a cross-origin map named by app-controlled source', () => {
    expect(isAllowedSourceUrl('https://evil.example/x.map', HERE)).toBe(false);
    expect(isAllowedSourceUrl('//evil.example/x.map', HERE)).toBe(false);
    expect(isAllowedSourceUrl('https://evil.example/../x.map', HERE)).toBe(false);
  });

  it('allows this document origin, however the URL is written', () => {
    expect(isAllowedSourceUrl('index.js.map', HERE)).toBe(true);
    expect(isAllowedSourceUrl('/app/index.js.map', HERE)).toBe(true);
    expect(isAllowedSourceUrl('http://localhost/app/index.js.map', HERE)).toBe(true);
  });

  it('allows every origin the BUNDLER already reaches — derived, not restated', () => {
    // Derived from the same module the fetchers and the M3 CSP read, so an origin
    // added for module loading is reachable here too and one removed is not. A
    // hand-written list here is exactly the drift `moduleOrigins.ts` exists to stop.
    const roots = [CDN_ROOT, UNPKG_ROOT, ESM_ORIGIN, ...Object.values(SELF_HOST_BASES)];
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(isAllowedSourceUrl(new URL('/some/path.map', root).toString(), HERE)).toBe(true);
    }
  });

  it('refuses non-http(s) schemes, so an opaque origin cannot pass as ours', () => {
    // `new URL('blob:http://localhost/uuid').origin` is 'null' in some engines and
    // the inner origin in others. Gating on the PROTOCOL first means neither
    // reading lets a blob/data/filesystem URL through.
    expect(isAllowedSourceUrl('blob:http://localhost/abc-123', HERE)).toBe(false);
    expect(isAllowedSourceUrl('data:application/json;base64,e30=', HERE)).toBe(false);
    expect(isAllowedSourceUrl('filesystem:http://localhost/temporary/x.map', HERE)).toBe(false);
    expect(isAllowedSourceUrl('javascript:fetch("//evil.example")', HERE)).toBe(false);
  });

  it('refuses an unparseable URL rather than treating it as relative-and-fine', () => {
    expect(isAllowedSourceUrl('http://[', HERE)).toBe(false);
  });
});

describe('fetchSourceText', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('does not issue a request at all for a refused URL', async () => {
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    await expect(fetchSourceText('https://evil.example/x.map', HERE)).resolves.toBeNull();
    // The point of the exit criterion: refused PRE-request, not filtered after.
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the body for an allowed URL', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: async () => '{"version":3}',
    }) as unknown as typeof fetch;
    await expect(fetchSourceText('index.js.map', HERE)).resolves.toBe('{"version":3}');
  });

  it('drops an over-long body, by declared length and by actual length', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': String(MAX_SOURCE_BYTES + 1) }),
      text: async () => 'x',
    }) as unknown as typeof fetch;
    await expect(fetchSourceText('index.js.map', HERE)).resolves.toBeNull();

    // A missing/lying content-length must not be the only defence.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: async () => 'x'.repeat(MAX_SOURCE_BYTES + 1),
    }) as unknown as typeof fetch;
    await expect(fetchSourceText('index.js.map', HERE)).resolves.toBeNull();
  });

  it('returns null on a non-ok response instead of throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      headers: new Headers(),
      text: async () => '',
    }) as unknown as typeof fetch;
    await expect(fetchSourceText('index.js.map', HERE)).resolves.toBeNull();
  });
});
