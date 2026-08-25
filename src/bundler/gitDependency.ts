/**
 * Parse a `package.json` `dependencies` VALUE that names a git-sourced (GitHub)
 * package, per the standard npm git-dependency convention
 * (LIBRARY_MOUNTS_SPEC §4). A library dependency is declared like any other —
 * the key is the import specifier, the value is a git source + ref:
 *
 *   "@scope/lib": "github:owner/repo#main"
 *   "@scope/lib": "owner/repo#<commitSHA>"            (bare shorthand)
 *   "@scope/lib": "git+https://github.com/owner/repo.git#v1.2.0"
 *
 * The bundler must recognize these AHEAD of its semver/CDN parser
 * (`concreteVersion()` accepts only `x.y.z` and would mis-default a `github:`
 * value), so this is the load-bearing piece of L2 (§4, §11). Pure: no bundler
 * imports, so it is unit-testable in isolation.
 */

/** A parsed GitHub git-dependency: the repo coordinates + the resolved ref. */
export interface GitDependency {
  owner: string;
  repo: string;
  /** Branch / tag / commit SHA; defaults to `main` when no `#ref` is given. */
  ref: string;
}

const SLASH_OR_BACKSLASH = new RegExp('[/\\\\]');
const WHITESPACE = new RegExp('\\s');

/** A path-traversal / control-char screen for the parsed components — a git
 *  specifier feeds a mount path (`/node_modules/<name>/`) and a host repo fetch,
 *  so reject anything with `..`, slashes inside a component, whitespace, or
 *  control chars (the §8 "don't probe for escapes" posture, enforced at the
 *  parser). Dots and hyphens stay allowed (refs like `v1.2.0`, branch names like
 *  `feature-x`). */
function isSafeComponent(value: string): boolean {
  if (value.length === 0) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('..')) return false;
  if (SLASH_OR_BACKSLASH.test(value)) return false;
  if (WHITESPACE.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return false; // control char
  }
  return true;
}

/**
 * Recognize a git-dependency `dependencies` value and parse its owner/repo/ref.
 * Returns `null` for anything that is not clearly a GitHub git dependency — a
 * plain semver (`^1.2.3`, `1.2.3`), a dist-tag (`latest`), `*`, a
 * `workspace:`/`file:`/`npm:` protocol, etc. — so the caller leaves those on the
 * CDN/semver path untouched.
 *
 * Conservative on the bare `owner/repo` shorthand: it is treated as a git dep
 * ONLY when it carries an explicit `#ref` (or a `github:` prefix / git URL),
 * never when it could be read as a version range, so a non-github value never
 * gets diverted off the CDN path.
 */
export function parseGitDependency(value: string): GitDependency | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;

  // Anything carrying another package protocol is not a github git dep.
  if (/^(npm|file|link|workspace|patch|portal):/i.test(raw)) return null;

  // Non-github git hosts (gitlab:, bitbucket:, generic git+ssh elsewhere) are out
  // of scope for L2 — only GitHub is wired (§4: `WIRED_MOUNT_SCHEMES`).
  if (/^(gitlab|bitbucket|gist):/i.test(raw)) return null;

  // Split off an optional `#ref` once; the body is the source, the rest the ref.
  const hashIx = raw.indexOf('#');
  const body = hashIx === -1 ? raw : raw.slice(0, hashIx);
  const refRaw = hashIx === -1 ? '' : raw.slice(hashIx + 1).trim();

  let ownerRepo: string | null = null;

  // Form 1: `github:owner/repo`
  const gh = body.match(/^github:(.+)$/i);
  if (gh) {
    ownerRepo = gh[1].trim();
  } else {
    // Form 2: a git URL pointing at github.com:
    //   git+https://github.com/owner/repo(.git)
    //   https://github.com/owner/repo(.git)
    //   git+ssh://git@github.com/owner/repo(.git)
    //   git://github.com/owner/repo(.git)
    const url = body.match(/^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/(.+?)(?:\.git)?\/?$/i);
    if (url) {
      ownerRepo = url[1].trim();
    } else if (hashIx !== -1 && /^[^\s:]+\/[^\s:/]+$/.test(body)) {
      // Form 3: bare `owner/repo` shorthand — treat as a git dep ONLY when an
      // explicit `#ref` is present (otherwise it could be a version range, a
      // path, etc.). Require exactly one slash and no protocol/space.
      ownerRepo = body;
    }
  }

  if (ownerRepo === null) return null;

  // Strip a trailing `.git` the shorthand/URL may carry, then split owner/repo.
  ownerRepo = ownerRepo.replace(/\.git$/i, '');
  const parts = ownerRepo.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;

  const ref = refRaw.length > 0 ? refRaw : 'main';

  if (!isSafeComponent(owner) || !isSafeComponent(repo) || !isSafeComponent(ref)) {
    return null;
  }

  return { owner, repo, ref };
}

/**
 * The set of dependency NAMES in `deps` whose value is a git-form specifier
 * (`parseGitDependency(value) !== null`). The bundler unions this into
 * `registryResolvedNames()` so a git dep is stripped from the CDN `/dep_tree/`
 * query and resolved from its registered local module instead
 * (LIBRARY_MOUNTS_SPEC §2.1/§4 L2). A plain semver/tag value is NOT included, so
 * it still resolves via the CDN.
 */
export function gitDependencyNames(deps: Record<string, string> | undefined): Set<string> {
  const names = new Set<string>();
  if (!deps) return names;
  for (const [name, value] of Object.entries(deps)) {
    if (parseGitDependency(value) !== null) names.add(name);
  }
  return names;
}
