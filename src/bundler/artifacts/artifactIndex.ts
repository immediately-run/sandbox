import { absolute, normalize } from '../../utils/path';

/**
 * R3-48 Gate 2 (G2-2) — the seeding-validation core for pre-transpiled artifacts
 * (`PRETRANSPILED_ARTIFACTS_SPEC` §4.2 index format, §5.1 seeding rules, §5.7
 * trust model). These are **pure** functions: no ZenFS, no bundler, no I/O, so
 * the security-critical rules (path confinement, manifest-entry membership,
 * `out` confinement, dirty-set, `srcSha` match, readable-layer-only, toolchain
 * stamp) are unit-testable in isolation. The wiring that reads `index.json`,
 * copies artifacts into `/transpiled`, and consults the dirty set lives in the
 * G2-5 integration; this module is the spine it leans on.
 *
 * Paths here are **repo-relative** (leading-slash, e.g. `/src/App.tsx`) — the
 * same space the manifest sidecar's `entries[]` use. Anchoring to `APP_ROOT`
 * (`/app/...`) and to the `/transpiled` mount is the caller's concern.
 */

/** The only artifact-index `schemaVersion` this runtime understands (§4.2). */
export const ARTIFACT_INDEX_SCHEMA_VERSION = 1;

/** Artifacts live under this repo-relative directory in the readable (zip) layer (§4.1). */
export const ARTIFACTS_DIR = '.tinkerable/artifacts';
const ARTIFACTS_PREFIX = `${ARTIFACTS_DIR}/`;

/** `index.json` `toolchain` block — the byte-identity stamp (§4.4). */
export interface ArtifactToolchain {
  transpiler: string;
  version: string;
  toolchainHash: string;
  preset: string;
}

/** One `files` entry in `index.json` (§4.2). */
export interface ArtifactFileEntry {
  /** Git blob SHA of the source — MUST equal the manifest entry's `sha` (§4.2). */
  srcSha: string;
  /** Output path, relative to `.tinkerable/artifacts/` (e.g. `transpiled/src/App.tsx.js`). */
  out: string;
  /** Raw dependency specifiers as the dep-collector reported them (§4.2). */
  deps: string[];
}

export interface ArtifactIndex {
  schemaVersion: number;
  toolchain: ArtifactToolchain;
  files: Record<string, ArtifactFileEntry>;
}

/** The runtime's own transpiler identity, compared against the index stamp (§4.4). */
export interface EmbeddedToolchainIdentity {
  version: string;
  toolchainHash: string;
}

/** Why a single `files` entry was skipped (§5.5 fall-through is per-file). */
export type SeedRejectReason =
  | 'bad-path'
  | 'not-in-manifest'
  | 'out-escapes-artifacts'
  | 'dirty'
  | 'srcsha-mismatch';

export type SeedValidation =
  | { ok: true; path: string; out: string; deps: string[] }
  | { ok: false; reason: SeedRejectReason };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isFileEntry(value: unknown): value is ArtifactFileEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.srcSha === 'string' && typeof e.out === 'string' && isStringArray(e.deps);
}

/**
 * Structurally validate a parsed `index.json` (§4.2). Returns the typed index or
 * `null` on any shape/`schemaVersion` failure (caller logs + boots live, §5.1).
 * Unknown extra keys are tolerated (forward-compat), the required shape is not.
 */
export function parseArtifactIndex(raw: unknown): ArtifactIndex | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const idx = raw as Record<string, unknown>;
  if (idx.schemaVersion !== ARTIFACT_INDEX_SCHEMA_VERSION) return null;

  const tc = idx.toolchain as Record<string, unknown> | undefined;
  if (
    typeof tc !== 'object' ||
    tc === null ||
    typeof tc.transpiler !== 'string' ||
    typeof tc.version !== 'string' ||
    typeof tc.toolchainHash !== 'string' ||
    typeof tc.preset !== 'string'
  ) {
    return null;
  }

  if (typeof idx.files !== 'object' || idx.files === null) return null;
  const files: Record<string, ArtifactFileEntry> = {};
  for (const [key, value] of Object.entries(idx.files as Record<string, unknown>)) {
    if (!isFileEntry(value)) return null;
    files[key] = { srcSha: value.srcSha, out: value.out, deps: value.deps };
  }

  return {
    schemaVersion: ARTIFACT_INDEX_SCHEMA_VERSION,
    toolchain: {
      transpiler: tc.transpiler,
      version: tc.version,
      toolchainHash: tc.toolchainHash,
      preset: tc.preset,
    },
    files,
  };
}

/**
 * The stamp gate (§4.4): artifacts are consumed only if **both** the transpiler
 * `version` and the `toolchainHash` match the runtime's embedded identity. A
 * version can survive a republish while the bytes drift, so the hash is required
 * too — either mismatch ignores all artifacts.
 */
export function toolchainMatches(toolchain: ArtifactToolchain, embedded: EmbeddedToolchainIdentity): boolean {
  return toolchain.version === embedded.version && toolchain.toolchainHash === embedded.toolchainHash;
}

/**
 * Validate + canonicalize an artifact-index path key (§5.1, §5.7): it must be an
 * absolute, repo-relative path with **no** empty/`.`/`..` segments. Returns the
 * clean path, or `null` to reject (no traversal out of the repo is permitted —
 * this is a security requirement, not just hygiene).
 */
export function normalizeRepoRelPath(key: string): string | null {
  if (typeof key !== 'string' || !key.startsWith('/')) return null;
  const segments = key.split('/').slice(1); // drop the leading ''
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return key;
}

/**
 * Confine an entry's `out` to `.tinkerable/artifacts/` (§5.1, §5.7): reject
 * absolute `out` and any value that normalizes outside the artifacts dir (`..`
 * traversal). Returns the confined repo-relative artifact path, or `null`.
 */
export function outWithinArtifacts(out: string): string | null {
  if (typeof out !== 'string' || out === '' || out.startsWith('/')) return null;
  const joined = normalize(ARTIFACTS_PREFIX + out);
  if (joined.startsWith(ARTIFACTS_PREFIX) && joined.length > ARTIFACTS_PREFIX.length) {
    return joined;
  }
  return null;
}

/**
 * Apply every §5.1 per-file seeding rule. A pass authorizes copying
 * `/app/<out>` → `/transpiled/<path>.js` (the caller anchors the mounts); any
 * failure skips that one file (§5.5) with a typed reason for logging.
 *
 * Order matters: path/membership/confinement and the dirty check run **before**
 * trusting `srcSha`, so a dirty or traversing entry can never reach the copy.
 */
export function validateSeedEntry(
  rawKey: string,
  entry: ArtifactFileEntry,
  ctx: { manifestShas: ReadonlyMap<string, string>; dirtySet: ReadonlySet<string> },
): SeedValidation {
  const path = normalizeRepoRelPath(rawKey);
  if (!path) return { ok: false, reason: 'bad-path' };

  const manifestSha = ctx.manifestShas.get(path);
  if (manifestSha === undefined) return { ok: false, reason: 'not-in-manifest' };

  const out = outWithinArtifacts(entry.out);
  if (!out) return { ok: false, reason: 'out-escapes-artifacts' };

  if (ctx.dirtySet.has(path)) return { ok: false, reason: 'dirty' };

  if (entry.srcSha !== manifestSha) return { ok: false, reason: 'srcsha-mismatch' };

  return { ok: true, path, out, deps: entry.deps };
}

/**
 * Readable-layer-only rule (§5.1, PT2-4): the whole artifact section is rejected
 * if **any** seeding input — the index, an artifact file, or the sidecar — is
 * present in the writable (COW) layer. Writable-layer copies are app-writable and
 * survive a Refresh, so a transiently-malicious version could plant artifacts that
 * keep executing after a "clean" refresh. Returns `true` only when every input is
 * readable-layer-only. The writable-layer set is parent-attested (it computes
 * `dirtyPaths`, §5.2), so this check is cheap.
 */
export function readableLayerOnly(
  seedingInputPaths: readonly string[],
  writableLayer: ReadonlySet<string>,
): boolean {
  return seedingInputPaths.every((p) => !writableLayer.has(p));
}

/**
 * Build the `path → git blob sha` lookup `validateSeedEntry` needs from the
 * manifest sidecar's `entries[]`. Keys are canonicalized to absolute repo-relative
 * form (matching `normalizeRepoRelPath`'s output) so lookups align; entries whose
 * path doesn't canonicalize are dropped.
 */
export function manifestShaMap(entries: ReadonlyArray<{ path: string; sha: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const { path, sha } of entries) {
    if (typeof path !== 'string' || typeof sha !== 'string') continue;
    const canonical = normalizeRepoRelPath(absolute(path));
    if (canonical) map.set(canonical, sha);
  }
  return map;
}
