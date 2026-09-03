import { createHash } from 'node:crypto';

import { sha384Bytes } from './sri';

// Expected values come from an INDEPENDENT producer — node's own SHA-384 — not
// from a second copy of the function under test, so a wrong digest or a wrong
// base64 alphabet cannot agree with itself.
const expectedSri = (bytes: Uint8Array): string => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('sha384Bytes', () => {
  it('formats the digest as SRI: `sha384-` + standard base64', async () => {
    const got = await sha384Bytes(utf8('hello'));
    expect(got).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
    expect(got).toBe(expectedSri(utf8('hello')));
  });

  it('is deterministic, and distinguishes inputs that differ by one byte', async () => {
    const a = await sha384Bytes(utf8('hello'));
    expect(await sha384Bytes(utf8('hello'))).toBe(a);
    expect(await sha384Bytes(utf8('hellp'))).not.toBe(a);
  });

  it('hashes the empty input rather than short-circuiting it', async () => {
    expect(await sha384Bytes(new Uint8Array(0))).toBe(expectedSri(new Uint8Array(0)));
  });

  it('accepts a plain ArrayBuffer as well as a view (the fetch cache passes one)', async () => {
    const view = utf8('immediately.run');
    const buffer = new ArrayBuffer(view.byteLength);
    new Uint8Array(buffer).set(view);
    expect(await sha384Bytes(buffer)).toBe(await sha384Bytes(view));
  });

  it('hashes bytes, not code units: the same text in a different encoding differs', async () => {
    const asUtf8 = await sha384Bytes(utf8('é'));
    const asLatin1 = await sha384Bytes(new Uint8Array([0xe9]));
    expect(asUtf8).not.toBe(asLatin1);
  });
});
