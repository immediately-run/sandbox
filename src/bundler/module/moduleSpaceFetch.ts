// The module-space fetch shadow (R3-426) — the runtime half that makes the shimmed
// `import.meta.url` COMPOSE with assets.
//
// With the R3-328 shim, `new URL('./add.wasm', import.meta.url)` resolves inside the
// frame to a sandbox module-space URL: `<location.origin>/app/src/add.wasm`. That URL is
// VIRTUAL — the origin's server does not serve app files, so a native `fetch` of it 404s
// and every Emscripten/wasm-pack loader (whose standard idiom is exactly
// `fetch(new URL('x.wasm', import.meta.url))`, streaming or not) dies. The mounted app
// tree, however, HAS those bytes.
//
// So the evaluator injects this wrapper as each module's `fetch`: a request whose URL
// points into this origin's module space (`/app/...`, the same predicate as the
// module-worker guard) and names a file that exists in the bundler fs is served from
// those bytes — status 200, Content-Type from the shared asset MIME table
// (`application/wasm` for `.wasm`, which `WebAssembly.instantiateStreaming` requires
// verbatim). Everything else — other origins, module-space paths with no backing file,
// non-GET/HEAD methods — falls through to the native `fetch` untouched.
//
// CONTAINMENT (R3-426 follow-up): the served path is percent-DECODED and `.`/`..`-
// normalized BEFORE the `/app/` containment check, and re-checked afterwards. The URL
// parser does not normalize `%2F`, so a check on the raw pathname would have let
// `/app/x/..%2F..%2Fnode_modules/…` decode to `/node_modules/…` — an escape from the
// module space this shadow is supposed to bound.
//
// KNOWN LIMITATION — `Range` is not honoured: a module-space hit always answers `200`
// with the whole file, never `206`. Chosen over implementing byte ranges because the
// idiom this shadow exists for (`fetch(new URL('x.wasm', import.meta.url))`, streaming
// or not) never sends one, ignoring `Range` is a spec-legal server response, and the
// files are already wholly in memory so a range would save nothing. `init.signal` IS
// honoured — an aborted request rejects with an `AbortError` like a real fetch.
//
// This serves module-RELATIVE resolution for files the bundler can see (the mounted app
// tree). It cannot make arbitrary-package URLs fetchable — a package whose loader
// computes a URL outside the module space (a CDN, its own origin) still needs the
// standard Emscripten escape hatch: pass `locateFile` (or the equivalent
// `wasmBinary`/explicit-URL option) to the loader, pointing at an imported `.wasm`
// asset's data URL (see transforms/asset). That convention is the documented fallback.

import type { Bundler } from '../bundler';
import { MODULE_ROOT } from '../../security/moduleWorkerGuard';
import { assetMimeType } from '../transforms/asset/mime';
import { normalize } from '../../utils/path';

/** Non-asset module-space files (source text, data) are served honestly as bytes. */
const DEFAULT_MIME = 'application/octet-stream';

function requestUrlOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof (input as { url?: unknown }).url === 'string') return (input as { url: string }).url;
  return null;
}

function requestMethodOf(input: unknown, init?: { method?: string }): string {
  const method = init?.method ?? (input as { method?: string } | null)?.method ?? 'GET';
  return String(method).toUpperCase();
}

/** The module-space filepath a request resolves to, or null when the request is not a
 *  GET/HEAD of a URL inside this origin's module space. */
export function moduleSpacePathOf(input: unknown, init?: { method?: string }): string | null {
  if (typeof location === 'undefined') return null;
  const raw = requestUrlOf(input);
  if (raw === null) return null;
  const method = requestMethodOf(input, init);
  if (method !== 'GET' && method !== 'HEAD') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, location.href);
  } catch {
    return null; // unparseable is the native fetch's error to raise, not ours
  }
  if (parsed.origin !== location.origin) return null;
  let decoded: string;
  try {
    // DECODE FIRST. `new URL()` leaves `%2F`/`%2e` alone, so a containment check on the
    // raw pathname is checking a string that has not yet become the path we will read:
    // `/app/x/..%2F..%2Fnode_modules/y` passes `startsWith('/app/')` and only THEN
    // decodes into an escape. Decode, normalize away `.`/`..`, and check the result —
    // the path we actually hand to the fs is the path that was authorized.
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null; // malformed percent-escapes are not a module-space path
  }
  const resolved = normalize(decoded);
  if (!resolved.startsWith(MODULE_ROOT)) return null;
  return resolved;
}

/** The `AbortSignal` governing a request, from `init` or from a `Request` input. */
function signalOf(input: unknown, init?: { signal?: AbortSignal | null }): AbortSignal | null {
  const fromInit = init?.signal;
  if (fromInit) return fromInit;
  const fromInput = (input as { signal?: AbortSignal | null } | null)?.signal;
  return fromInput ?? null;
}

/** What `fetch` rejects with on abort: the signal's own reason, else an AbortError. */
function abortReasonOf(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** Settle `work`, but reject as soon as `signal` aborts (the fs read cannot be cancelled;
 *  the caller stops waiting on it, which is what an aborted fetch observably does). */
function withAbort<T>(signal: AbortSignal | null, work: Promise<T>): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReasonOf(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Build the `fetch` the evaluator injects per module: serve module-space files from the
 * bundler fs, delegate everything else to the native `fetch`.
 */
export function createModuleSpaceFetch(bundler: Bundler): typeof globalThis.fetch {
  const moduleSpaceFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const filepath = moduleSpacePathOf(input, init);
    if (filepath !== null) {
      // Honour `init.signal` (or a Request's own) the way a real fetch does: an
      // already-aborted request never touches the fs, and one aborted in flight stops
      // waiting on the read. Without this a served hit resolved 200 on an aborted
      // request, so no consumer's abort ever worked in module space.
      const signal = signalOf(input, init);
      if (signal?.aborted) throw abortReasonOf(signal);
      const bytes = await withAbort(
        signal,
        (async () => ((await bundler.fs.isFileAsync(filepath)) ? await bundler.fs.readBytesAsync(filepath) : null))(),
      );
      if (bytes !== null) {
        // Copy: the fs layer caches its Uint8Array, and a Response body must not alias
        // a buffer a later consumer could observe mutated (or detach via transfer).
        const body = bytes.slice();
        return new Response(requestMethodOf(input, init) === 'HEAD' ? null : body, {
          status: 200,
          headers: {
            'Content-Type': assetMimeType(filepath) ?? DEFAULT_MIME,
            'Content-Length': String(bytes.byteLength),
          },
        });
      }
    }
    const native = (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
    if (typeof native !== 'function') {
      throw new TypeError('fetch is not available in this environment');
    }
    return native.call(globalThis, input as RequestInfo, init);
  };
  return moduleSpaceFetch as typeof globalThis.fetch;
}
