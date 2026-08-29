/**
 * The origin bound on source-map and source-text fetches made by the error
 * listener (R3-367 finding 3).
 *
 * ## Why this exists
 *
 * Two fetches in the error path take an **app-controlled** URL and issue it from
 * the bundler's own document:
 *
 *  - `unmapper.ts` fetches `fileUri`, which arrives as `error.__unmap_source`.
 *  - `get-source-map.ts` fetches a URL derived from the `//# sourceMappingURL=`
 *    comment inside a module's compiled source. An app that ships
 *    `//# sourceMappingURL=https://evil.example/x.map` and then throws makes the
 *    document fetch that URL.
 *
 * Neither is an execution primitive, but both are an **egress oracle**: the app
 * chooses a destination and learns, from whether the enhanced frame comes back,
 * that the request happened. Under M0–M2 there is no per-frame `connect-src` to
 * stop it (M3's does contain it), so the bound has to be in the code.
 *
 * ## The rule
 *
 * A source fetch may reach exactly what the BUNDLER already reaches: this
 * document's own origin, plus the module origins single-sourced in
 * `bundler/moduleOrigins.ts`. That set is not widened here — it is imported, so
 * an origin added for module loading is automatically legible to source maps and
 * an origin removed there stops being reachable from here too. Copying the list
 * is what let the M3 CSP and the fetchers drift before (see that file's header).
 *
 * `data:` never reaches this predicate: an inline base64 map is decoded in
 * `get-source-map.ts` without a fetch, which is the common case for a bundled
 * module and stays fast.
 *
 * ## Failure shape
 *
 * A refused URL is NOT an error. The caller degrades to an unmapped frame — the
 * stack still renders, it just is not source-mapped. Throwing would turn a
 * hostile source-map URL into a way to suppress the error overlay entirely,
 * which is a worse outcome than a coarser stack.
 */
import { CDN_ROOT, ESM_ORIGIN, SELF_HOST_BASES, UNPKG_ROOT } from '../bundler/moduleOrigins';

/**
 * Cap on a fetched source or source-map body. Source maps are large — a few MB
 * is ordinary for a big dependency — so this is generous; it exists to stop an
 * app pointing the document at an endless response, not to police size.
 */
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/** The origins the bundler itself reaches, derived (never restated). */
const moduleOrigins = (): string[] => {
  const roots = [CDN_ROOT, UNPKG_ROOT, ESM_ORIGIN, ...Object.values(SELF_HOST_BASES)];
  return roots.map((r) => {
    try {
      return new URL(r).origin;
    } catch {
      return '';
    }
  });
};

/**
 * May the error listener fetch this URL?
 *
 * Relative and same-origin absolute URLs resolve against this document and pass.
 * A cross-origin URL passes only if its origin is one the bundler already loads
 * modules from.
 */
export const isAllowedSourceUrl = (url: string, base: string = location.href): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    // Unparseable is not "same-origin by default" — refuse rather than guess.
    return false;
  }
  // `blob:`/`data:`/`filesystem:` and friends have a null or opaque origin; the
  // only scheme we serve source from is http(s). An opaque-origin URL that
  // happens to stringify with our origin must not slip through.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.origin === location.origin) return true;
  return moduleOrigins().includes(parsed.origin);
};

/**
 * Fetch a source or source-map body under the origin bound and the size cap.
 * Resolves `null` when the URL is refused or the body is over-long, so every
 * caller degrades the same way.
 */
export const fetchSourceText = async (url: string, base: string = location.href): Promise<string | null> => {
  if (!isAllowedSourceUrl(url, base)) return null;
  const res = await fetch(new URL(url, base).toString());
  if (!res.ok) return null;
  // Trust the declared length when it is present and over the cap — no reason to
  // stream a body we have already decided to drop.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) return null;
  const text = await res.text();
  return text.length > MAX_SOURCE_BYTES ? null : text;
};
