/**
 * Every network origin the **bundler itself** reaches for module loading, in one
 * place.
 *
 * These used to sit as private constants next to the code that fetches them,
 * which was fine until the M3 per-frame CSP (`security/m3Csp.ts`,
 * `UI_AS_APPS_SPEC §G1a` / R3-234) had to enumerate the same set: an M3 app
 * shares this document with the bundler, so a `connect-src` that misses one of
 * these does not contain the app — it stops every M3 app from booting, in
 * production, with no local signal.
 *
 * So they are single-sourced here and consumed by both the fetchers and the
 * policy (ways_of_working §6: shared vocabularies are published once, not
 * copied). `security/m3Csp.test.ts` asserts the policy still covers each one.
 */

/**
 * The live dependency-resolution CDN (`/dep_tree/` + `/package/`).
 * `PRETRANSPILED_ARTIFACTS_SPEC §0/§5.4` references its endpoints.
 */
export const CDN_ROOT = 'https://sandpack-cdn-staging.blazingly.io/';

/** Registry file reads at registry-resolved exact versions (`RegistryFS`). */
export const UNPKG_ROOT = 'https://unpkg.com/';

/** The esm.sh fallback for packages the primary CDN cannot resolve. */
export const ESM_ORIGIN = 'https://esm.sh';

/**
 * Self-hosted, versioned builds published by a module's own release CI, keyed by
 * module name (`SDK_PACKAGING_SPEC §5/§11`, Option A). Each `<base>/v/<version>/`
 * path encodes the exact version, so its responses are immutable.
 */
export const SELF_HOST_BASES: Record<string, string> = {
  '@immediately-run/sdk': 'https://immediately-run.github.io/immediately-run-sdk',
};
