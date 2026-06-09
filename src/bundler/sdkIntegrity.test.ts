/**
 * @jest-environment jsdom
 *
 * SDK integrity verification (SDK_PACKAGING_SPEC §5.2 / SPEC_REVIEW SP-2).
 */
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { webcrypto } from 'node:crypto';
import { sha384, verifyVendoredFiles, pinnedHashesFor, decideIntegrity } from './sdkIntegrity';

// jsdom in this jest setup doesn't expose TextEncoder / crypto.subtle / btoa
// (the real iframe runtime does). Polyfill from node before any test runs them.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.TextEncoder === 'undefined') g.TextEncoder = NodeTextEncoder;
  if (typeof g.crypto === 'undefined') g.crypto = webcrypto;
  if (typeof g.btoa === 'undefined') g.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
});

describe('sha384', () => {
  it('produces an SRI-formatted SHA-384 of the UTF-8 content', async () => {
    const h = await sha384('hello');
    expect(h).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
    // Stable for the same input.
    expect(await sha384('hello')).toBe(h);
    expect(await sha384('hello!')).not.toBe(h);
  });
});

describe('verifyVendoredFiles', () => {
  const files = [
    { rel: 'index.js', content: 'export const x = 1;' },
    { rel: 'package.json', content: '{"name":"@immediately-run/sdk"}' },
  ];

  const pinOf = async (fs: typeof files) =>
    Object.fromEntries(await Promise.all(fs.map(async (f) => [f.rel, await sha384(f.content)])));

  it('passes when every pinned file matches', async () => {
    const expected = await pinOf(files);
    const res = await verifyVendoredFiles(files, expected);
    expect(res.ok).toBe(true);
    expect(res.mismatches).toEqual([]);
    expect(res.missing).toEqual([]);
  });

  it('flags a tampered file (bytes differ from the pin)', async () => {
    const expected = await pinOf(files);
    const tampered = [{ ...files[0], content: 'export const x = 2; /* injected */' }, files[1]];
    const res = await verifyVendoredFiles(tampered, expected);
    expect(res.ok).toBe(false);
    expect(res.mismatches).toEqual(['index.js']);
  });

  it('flags a pinned file omitted from the fetched set (truncated artifact)', async () => {
    const expected = await pinOf(files);
    const res = await verifyVendoredFiles([files[0]], expected); // package.json missing
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['package.json']);
  });

  it('ignores extra fetched files not in the pin (the pin is authoritative)', async () => {
    const expected = await pinOf([files[0]]); // only index.js pinned
    const res = await verifyVendoredFiles([...files, { rel: 'extra.js', content: 'x' }], expected);
    expect(res.ok).toBe(true);
  });
});

describe('pinnedHashesFor', () => {
  const integrity = { '@immediately-run/sdk': { '0.4.0': { 'index.js': 'sha384-abc' } } };
  it('returns the per-version hashes when present', () => {
    expect(pinnedHashesFor(integrity, '@immediately-run/sdk', '0.4.0')).toEqual({ 'index.js': 'sha384-abc' });
  });
  it('returns undefined for an unpinned version or module, or no integrity', () => {
    expect(pinnedHashesFor(integrity, '@immediately-run/sdk', '0.2.8')).toBeUndefined();
    expect(pinnedHashesFor(integrity, 'other', '0.4.0')).toBeUndefined();
    expect(pinnedHashesFor(undefined, '@immediately-run/sdk', '0.4.0')).toBeUndefined();
  });
});

describe('decideIntegrity (SDK_PACKAGING_SPEC §5.2 fail-closed-on-missing-version)', () => {
  const integrity = { '@immediately-run/sdk': { '0.4.0': { 'index.js': 'sha384-abc' } } };

  it('verifies when the host pinned the resolved version', () => {
    expect(decideIntegrity(integrity, '@immediately-run/sdk', '0.4.0')).toEqual({
      action: 'verify',
      hashes: { 'index.js': 'sha384-abc' },
    });
  });

  it('FAILS CLOSED when the host wired integrity but not this version', () => {
    // The §5.2 hardening: a missing manifest entry must not silently skip
    // verification (an attacker landing on an unpinned version would bypass it).
    expect(decideIntegrity(integrity, '@immediately-run/sdk', '0.2.8')).toEqual({ action: 'fail-closed' });
    expect(decideIntegrity(integrity, 'other-module', '0.4.0')).toEqual({ action: 'fail-closed' });
  });

  it('skips when no host pin exists at all (guarantee inactive, not failed)', () => {
    expect(decideIntegrity(undefined, '@immediately-run/sdk', '0.4.0')).toEqual({ action: 'skip' });
  });
});
