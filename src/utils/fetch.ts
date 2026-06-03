import { FetchError } from '../errors/FetchError';
import { sleep } from './sleep';

interface RetryOptions {
  maxRetries?: number;
  retryDelay?: number;
}

export type RequestInitWithRetry = RequestInit & RetryOptions;

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
// prefixes (see module-cdn.ts / NodeModuleFSLayer.ts) to avoid an import cycle
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
 * Fetches a resource using the provided config and retries if it fails with a network or server availability error
 *
 * @param {RequestInfo} input: request info for fetch
 * @param {RequestInit} init: request options for fetch
 * @param {pRetry.PromiseRetryOptions} retryOptions: Retry configuration
 * @returns {Response}
 */
export async function retryFetch(input: RequestInfo, init: RequestInitWithRetry = {}, count = 0): Promise<Response> {
  if (typeof input === 'string' && immutableUrlPrefixes.some((prefix) => input.startsWith(prefix))) {
    const cache = await openImmutableCache();
    if (cache) {
      const hit = await cache.match(input).catch(() => undefined);
      if (hit) {
        return hit;
      }
      const result = await retryFetchUncached(input, init, count);
      // Clone before the caller consumes the body; a failed put (e.g. quota)
      // only costs the cache entry.
      await cache.put(input, result.clone()).catch(() => {});
      return result;
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
