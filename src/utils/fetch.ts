import { FetchError } from '../errors/FetchError';
import { sleep } from './sleep';

interface RetryOptions {
  maxRetries?: number;
  retryDelay?: number;
  /**
   * Expected `sha384-<base64>` of the response body for an immutable URL. When
   * set, the immutable cache becomes integrity-aware (cache-poisoning
   * prevention): a cache hit whose bytes no longer match is evicted + refetched
   * (self-heal), and freshly fetched bytes are only stored when they match
   * (never persist unverified bytes). Distinct from the native `integrity`
   * RequestInit field on purpose — that makes the browser HARD-FAIL the fetch on
   * mismatch, but we want to return mismatched bytes so the caller's own
   * verification fails closed with a precise error, while just refusing to cache.
   */
  pinnedSri?: string;
}

export type RequestInitWithRetry = RequestInit & RetryOptions;

/** SHA-384 of bytes, `sha384-<base64>` (SRI style). */
const sha384 = async (body: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-384', body);
  let bin = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return `sha384-${btoa(bin)}`;
};

/** Whether a response's body matches `sri` (true when no `sri` to check). A
 *  hashing failure (no crypto) counts as a non-match so we never serve/persist
 *  bytes we couldn't validate. */
const responseMatchesSri = async (res: Response, sri: string | undefined): Promise<boolean> => {
  if (!sri) return true;
  try {
    return (await sha384(await res.clone().arrayBuffer())) === sri;
  } catch {
    return false;
  }
};

// 408 is timeout
// 429 is too many requests
// 424 is failed dependency
// 499 is client closed connection
// 444 is connection closed without response
// 502 is Bad gateway
// 503 is Service Unavailable
// 504 is Gateway Timeout
// 599 is Network Connect Timeout Error
const ERROR_CODES_TO_RETRY = new Set([408, 429, 424, 499, 444, 502, 503, 504, 599]);
function isRetryableStatus(status: number): boolean {
  return ERROR_CODES_TO_RETRY.has(status);
}

// URL prefixes whose responses are immutable — the URL encodes the exact
// content version (e.g. the module CDN's /package/<name@version> endpoints, or
// unpkg files at an exact version). Such responses are served cache-first from
// a persistent Cache API cache: a hit never touches the network, a miss
// populates the cache after a successful fetch. Callers register their own
// prefixes (see module-cdn.ts / RegistryFS.ts) to avoid an import cycle
// back into this module. Do NOT register endpoints that resolve floating
// versions (semver ranges, tags): caching those would pin the resolution.
const immutableUrlPrefixes: string[] = [];

export const registerImmutableUrlPrefix = (prefix: string): void => {
  immutableUrlPrefixes.push(prefix);
};

const IMMUTABLE_CACHE_NAME = 'immutable-url-cache-v1';

// CacheStorage can be unavailable or outright forbidden — in a sandboxed iframe
// without `allow-same-origin` (an opaque origin, i.e. this bundler in
// production) even *reading* `window.caches` throws. Cache failures must
// degrade to a plain network fetch, never break the request itself.
const openImmutableCache = async (): Promise<Cache | undefined> => {
  try {
    return await caches.open(IMMUTABLE_CACHE_NAME);
  } catch {
    return undefined;
  }
};

/**
 * The result of a parent-side immutable fetch (see `handleImmutableFetch` in
 * sandpack-client). The body is structured-cloned across the iframe boundary.
 */
export interface ParentImmutableFetchResult {
  status: number;
  contentType: string;
  body: ArrayBuffer;
}

// In the production iframe (opaque origin) there is no local CacheStorage at
// all, so immutable fetches are forwarded to the parent window, which serves
// them from its own persistent cache. Registered by SandpackInstance (which
// owns the message bus) to avoid an import cycle into the protocol layer.
let parentImmutableFetch:
  | ((url: string, integrity?: string) => Promise<ParentImmutableFetchResult>)
  | undefined;

export const registerParentImmutableFetch = (
  fn: (url: string, integrity?: string) => Promise<ParentImmutableFetchResult>,
): void => {
  parentImmutableFetch = fn;
};

// An older parent build may not implement the immutable-fetch protocol, in
// which case the request never gets a reply — bound the wait and fall back to
// a direct network fetch.
const PARENT_FETCH_TIMEOUT_MS = 3000;

const fetchViaParent = async (url: string, integrity?: string): Promise<Response | undefined> => {
  if (!parentImmutableFetch) {
    return undefined;
  }
  try {
    const result = await Promise.race([
      parentImmutableFetch(url, integrity),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PARENT_FETCH_TIMEOUT_MS)),
    ]);
    if (!result) {
      // No reply: the parent predates the protocol. Disable the bridge for
      // the rest of the session so only the first (concurrent) batch of
      // requests pays the timeout.
      parentImmutableFetch = undefined;
      return undefined;
    }
    return new Response(new Blob([result.body], { type: result.contentType }), {
      status: result.status,
    });
  } catch {
    // Parent refused (e.g. URL outside its allowlist) or failed — let the
    // caller fetch directly.
    return undefined;
  }
};

/**
 * Fetches a resource using the provided config and retries if it fails with a network or server availability error
 *
 * @param {RequestInfo} input: request info for fetch
 * @param {RequestInit} init: request options for fetch
 * @param {pRetry.PromiseRetryOptions} retryOptions: Retry configuration
 * @returns {Response}
 */
export async function retryFetch(input: RequestInfo, init: RequestInitWithRetry = {}, count = 0): Promise<Response> {
  if (typeof input === 'string' && immutableUrlPrefixes.some((prefix) => input.startsWith(prefix))) {
    const { pinnedSri } = init;
    const cache = await openImmutableCache();
    if (cache) {
      const hit = await cache.match(input).catch(() => undefined);
      if (hit) {
        // verify-on-read: serve a hit only if it still matches the pin; an entry
        // the host has since re-pinned is evicted + refetched (self-heal).
        if (await responseMatchesSri(hit, pinnedSri)) {
          return hit;
        }
        await cache.delete(input).catch(() => {});
      }
      const result = await retryFetchUncached(input, init, count);
      // verify-before-cache: only persist bytes that match the pin, so a bad
      // upstream window can't poison the cache. The (mismatching) bytes are still
      // returned — the caller's own integrity check fails closed precisely.
      if (await responseMatchesSri(result, pinnedSri)) {
        // Clone before the caller consumes the body; a failed put (e.g. quota)
        // only costs the cache entry.
        await cache.put(input, result.clone()).catch(() => {});
      }
      return result;
    }
    // No local CacheStorage (opaque origin): use the parent's persistent
    // cache over the message bus, falling back to a direct fetch.
    const viaParent = await fetchViaParent(input, pinnedSri);
    if (viaParent) {
      return viaParent;
    }
  }
  return retryFetchUncached(input, init, count);
}

async function retryFetchUncached(input: RequestInfo, init: RequestInitWithRetry = {}, count = 0): Promise<Response> {
  const { maxRetries = 0, retryDelay = 500 } = init;
  if (count > maxRetries) {
    throw new Error('Fetch failed, maximum retries exceeded');
  }
  const shouldRetry = count < maxRetries;
  try {
    const result = await window.fetch(input, init);
    if (result.ok) {
      return result;
    }
    // Don't use p-retry it cannot be scope hoisted properly
    // See https://github.com/parcel-bundler/parcel/issues/7866
    const isRetryable = isRetryableStatus(result.status);
    if (!shouldRetry || !isRetryable) {
      const text = await result.text().catch(() => '');
      throw new FetchError(result, text);
    }
  } catch (err) {
    if (!shouldRetry) {
      throw err;
    }
  }
  await sleep(retryDelay);
  return retryFetchUncached(input, init, count + 1);
}
