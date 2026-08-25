import { APP_ROOT, CONTRIBUTE_MANIFEST_PATH, stripAppRoot, underAppRoot } from '@immediately-run/platform-constants';

/**
 * The app-root path space now has ONE definition, in
 * `@immediately-run/platform-constants` (R3-275): this module and the SDK's
 * `urlUtils.ts` each declared their own `/app` and their own join, and nothing made
 * the two agree — while the metadata key space is derived from the constant on both
 * sides. Re-exported here so every existing import site is unchanged.
 *
 * The sandbox filesystem is rooted at `/` so app code can reach the whole tree (the
 * repo plus any dynamically-added mounts such as a Firestore-backed store); the
 * parent window's repository filesystem is mounted at `APP_ROOT`.
 */
export { APP_ROOT, underAppRoot, stripAppRoot };

/**
 * Repo-relative path of the contribute-manifest sidecar a cache zip carries
 * (mirrors ZIP_MANIFEST_SIDECAR_PATH in immediately-run-site-main). Present
 * under APP_ROOT only when the repo was mounted from a cache zip; the bundler
 * reads its optional `lockset` section (PRETRANSPILED_ARTIFACTS_SPEC §5.4).
 */
export const MANIFEST_SIDECAR_PATH = `/${CONTRIBUTE_MANIFEST_PATH}`;
