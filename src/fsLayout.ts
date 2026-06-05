/**
 * The sandbox filesystem is rooted at `/` so app code can reach the whole tree
 * (the repo plus any dynamically-added mounts such as a Firestore-backed store).
 * The parent window's repository filesystem is mounted here:
 */
export const APP_ROOT = '/app';

/**
 * Repo-relative path of the contribute-manifest sidecar a cache zip carries
 * (mirrors ZIP_MANIFEST_SIDECAR_PATH in immediately-run-site-main). Present
 * under APP_ROOT only when the repo was mounted from a cache zip; the bundler
 * reads its optional `lockset` section (PRETRANSPILED_ARTIFACTS_SPEC §5.4).
 */
export const MANIFEST_SIDECAR_PATH = '/.tinkerable/contribute-manifest.json';

/** Join `APP_ROOT` with a repo-relative path (which may or may not be slash-prefixed). */
export const underAppRoot = (repoRelativePath: string): string => {
  const suffix = repoRelativePath.startsWith('/') ? repoRelativePath : `/${repoRelativePath}`;
  return `${APP_ROOT}${suffix}`;
};

/**
 * Map an absolute sandbox path back to the repo-relative path apps and the URL
 * space think in (`/app/posts/x.mdx` → `/posts/x.mdx`). Paths outside the repo
 * (node_modules, other mounts) are returned unchanged.
 */
export const stripAppRoot = (path: string): string => {
  if (path === APP_ROOT) {
    return '/';
  }
  return path.startsWith(`${APP_ROOT}/`) ? path.slice(APP_ROOT.length) : path;
};
