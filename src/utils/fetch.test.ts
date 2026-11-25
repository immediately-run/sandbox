/**
 * utils/fetch.ts — retryFetch's immutable-cache routing, pinned at the unit
 * level for the R3-820 `bypassImmutableCache` flag: a URL whose ADDRESS does
 * not pin its content (a `name@^range/package.json` probe) must never be served
 * from (or written to) the persistent cache, or the floating resolution freezes
 * across sessions. Cache and network are faked at the global seams
 * (`caches`, `window.fetch`) the implementation reads.
 */
import { registerImmutableUrlPrefix, retryFetch } from './fetch';

const PREFIX = 'https://unit-immutable.example/';

describe('retryFetch immutable-cache routing (R3-820)', () => {
  let cacheMatch: jest.Mock;
  let cachePut: jest.Mock;
  let windowFetch: jest.Mock;
  let prevCaches: unknown;
  let prevWindow: unknown;

  beforeAll(() => {
    registerImmutableUrlPrefix(PREFIX);
  });

  beforeEach(() => {
    cacheMatch = jest.fn(async () => undefined);
    cachePut = jest.fn(async () => undefined);
    const fakeCache = { match: cacheMatch, put: cachePut, delete: async () => undefined };
    prevCaches = (globalThis as Record<string, unknown>).caches;
    prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).caches = { open: async () => fakeCache };
    windowFetch = jest.fn(async () => new Response('FRESH'));
    (globalThis as Record<string, unknown>).window = { fetch: windowFetch };
  });

  afterAll(() => {
    (globalThis as Record<string, unknown>).caches = prevCaches;
    (globalThis as Record<string, unknown>).window = prevWindow;
  });

  it('serves a registered-prefix URL cache-first and never touches the network', async () => {
    cacheMatch.mockResolvedValue(new Response('CACHED'));
    const res = await retryFetch(`${PREFIX}pkg@1.0.0/file.js`);
    expect(await res.text()).toBe('CACHED');
    expect(windowFetch).not.toHaveBeenCalled();
  });

  it('bypassImmutableCache skips the persistent cache entirely (a range URL must not freeze)', async () => {
    cacheMatch.mockResolvedValue(new Response('CACHED')); // a poisoned/stale entry must be ignored
    const res = await retryFetch(`${PREFIX}pkg@^1.0.0/package.json`, { bypassImmutableCache: true });
    expect(await res.text()).toBe('FRESH'); // the network answer, not the cached one
    expect(windowFetch).toHaveBeenCalledTimes(1);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled(); // and the probe is not persisted either
  });

  it('without the flag, a prefix miss is fetched and persisted for next time', async () => {
    const res = await retryFetch(`${PREFIX}pkg@1.0.0/other.js`);
    expect(await res.text()).toBe('FRESH');
    expect(windowFetch).toHaveBeenCalledTimes(1);
    expect(cachePut).toHaveBeenCalledTimes(1); // immutable by address → cached
  });
});
