import { CRYPTO_MODULE_CODE } from './bundler';

// R3-411 (review): the `crypto` builtin shim replaced a LOUD bundle-time failure
// (`Cannot find module 'crypto'`) with a shim — so the shim must never answer
// wrongly. Two confirmed defects this pins:
//   4. `randomBytes(16).toString('hex')` — the canonical call — produced
//      `"12,45,200,…"` (Array#toString on a bare Uint8Array), not 32 hex chars.
//   5. `randomBytes`/`randomFillSync` passed the whole range to `getRandomValues`,
//      which throws QuotaExceededError above 65536 bytes.

/** What Node's `randomBytes` returns: bytes that also answer `toString(encoding)`. */
type BufferLike = Uint8Array & { toString(encoding?: string): string };

interface CryptoShim {
  randomBytes(size: number, cb?: (err: unknown, bytes: BufferLike) => void): BufferLike;
  pseudoRandomBytes(size: number): BufferLike;
  randomFillSync(buffer: Uint8Array, offset?: number, size?: number): Uint8Array;
  randomUUID(): string;
  createHash(alg: string): unknown;
}

/** Evaluate the shim source the way the bundler does: as a CommonJS module. */
function loadShim(): CryptoShim {
  const module = { exports: {} as CryptoShim };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', CRYPTO_MODULE_CODE)(module, module.exports);
  return module.exports;
}

/** …with no ambient `Buffer`, i.e. the real browser sandbox, where the shim's own
 *  Buffer-compatible `toString` is the only thing standing between the app and a
 *  silently wrong value. (Node's jest env HAS Buffer, so it must be removed to
 *  exercise that branch at all.) */
function loadShimWithoutBuffer(): CryptoShim {
  const g = globalThis as Record<string, unknown>;
  const prev = g.Buffer;
  delete g.Buffer;
  try {
    return loadShim();
  } finally {
    if (prev !== undefined) g.Buffer = prev;
  }
}

const HEX_32 = /^[0-9a-f]{32}$/;

describe.each([
  ['with an app-supplied Buffer', loadShim],
  ['in a browser sandbox with no Buffer', loadShimWithoutBuffer],
])('crypto shim %s', (_label, load) => {
  it("randomBytes(16).toString('hex') is 32 lowercase hex chars", () => {
    const shim = load();
    const hex = shim.randomBytes(16).toString('hex');
    expect(hex).toMatch(HEX_32);
    // The pre-fix failure mode, stated explicitly: comma-joined decimal bytes.
    expect(hex).not.toContain(',');
  });

  it('the hex encodes exactly the bytes returned', () => {
    const shim = load();
    const bytes = shim.randomBytes(16);
    const expected = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(bytes.toString('hex')).toBe(expected);
  });

  it('is still a real Uint8Array of the requested length', () => {
    const shim = load();
    const bytes = shim.randomBytes(16);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(16);
  });

  it("toString('base64') round-trips, and toString('utf8') decodes", () => {
    const shim = load();
    const bytes = shim.randomBytes(16);
    const b64 = bytes.toString('base64');
    expect(b64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))).toEqual(Uint8Array.from(bytes));

    const hello = shim.randomBytes(5);
    hello.set([104, 101, 108, 108, 111]); // "hello"
    expect(hello.toString('utf8')).toBe('hello');
  });

  it('randomBytes(0) is empty and stringifies to empty', () => {
    const shim = load();
    expect(shim.randomBytes(0)).toHaveLength(0);
    expect(shim.randomBytes(0).toString('hex')).toBe('');
  });

  it('the callback form gets the same Buffer-compatible bytes', () => {
    const shim = load();
    let seen: BufferLike | null = null;
    shim.randomBytes(16, (err, bytes) => {
      expect(err).toBeNull();
      seen = bytes;
    });
    expect(seen!.toString('hex')).toMatch(HEX_32);
  });

  it('pseudoRandomBytes answers the same shape', () => {
    const shim = load();
    expect(shim.pseudoRandomBytes(16).toString('hex')).toMatch(HEX_32);
  });

  // Finding 5: getRandomValues throws QuotaExceededError above 65536 bytes.
  it.each([65536, 65537, 100000, 200001])('randomBytes(%i) works above the getRandomValues quota', (size) => {
    const shim = load();
    const bytes = shim.randomBytes(size);
    expect(bytes).toHaveLength(size);
    // Every chunk was filled: an all-zero tail would mean a chunk was skipped.
    expect(bytes.subarray(size - 32).some((b) => b !== 0)).toBe(true);
    // …including the bytes just past the first chunk boundary.
    if (size > 65536) expect(bytes.subarray(65536, 65568).some((b) => b !== 0)).toBe(true);
  });

  it('randomFillSync fills a >64 KiB buffer, and honours offset/size', () => {
    const shim = load();
    const big = new Uint8Array(100000);
    expect(() => shim.randomFillSync(big)).not.toThrow();
    expect(big.subarray(99968).some((b) => b !== 0)).toBe(true);

    const framed = new Uint8Array(64);
    shim.randomFillSync(framed, 8, 16);
    expect(framed.subarray(0, 8).every((b) => b === 0)).toBe(true);
    expect(framed.subarray(24).every((b) => b === 0)).toBe(true);
    expect(framed.subarray(8, 24).some((b) => b !== 0)).toBe(true);
  });

  it('unshimmable APIs still throw only when actually called', () => {
    const shim = load();
    expect(() => shim.createHash('sha256')).toThrow(/not supported in the browser sandbox/);
    expect(shim.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
