import { APP_ROOT, MANIFEST_SIDECAR_PATH, stripAppRoot, underAppRoot } from '../../fsLayout';
import { parseFrontmatter, transformFile } from '@immediately-run/transpiler';
import {
  ARTIFACTS_DIR,
  type ArtifactIndex,
  type EmbeddedToolchainIdentity,
  manifestShaMap,
  normalizeRepoRelPath,
  outWithinArtifacts,
  parseArtifactIndex,
  readableLayerOnly,
  toolchainMatches,
  validateSeedEntry,
} from './artifactIndex';

const TRANSPILED_ROOT = '/transpiled';
// Repo-relative seeding-input paths (leading-slash, the dirty-set/COW key space).
const INDEX_REPO_PATH = `/${ARTIFACTS_DIR}/index.json`;
/** The frontmatter content-collection sidecar (MDX_CONTENT_COLLECTIONS_SPEC §1.3). */
const MDX_METADATA_REPO_PATH = `/${ARTIFACTS_DIR}/mdx-metadata.json`;
/** Minimum spot-verification sample size (§5.7 — K ≥ 2, a floor not a ceiling). */
export const SPOT_VERIFY_K = 2;

/** The narrow fs surface the store needs (CachedFS implements all of these). */
export interface ArtifactFs {
  readFileAsync(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  isFileAsync(path: string): Promise<boolean>;
  deleteFile(path: string): Promise<void>;
}

/** The `/transpiled` tmpfs path a module's app path consults/writes through. */
function transpiledPathFor(appModulePath: string): string {
  return `${TRANSPILED_ROOT}${stripAppRoot(appModulePath)}.js`;
}

/** True for app-root source modules (the only ones with artifacts). */
function isAppModule(path: string): boolean {
  return path === APP_ROOT || path.startsWith(`${APP_ROOT}/`);
}

export interface SeedContext {
  /** §5.2 dirty set: repo-relative paths never seeded (writable-layer + deleted). */
  dirtySet: ReadonlySet<string>;
  /** Writable (COW) layer membership for the §5.1 readable-layer-only gate. */
  writableLayer: ReadonlySet<string>;
}

export interface SeedResult {
  seeded: number;
  /** Set when the whole section was rejected for a security reason (§5.1 PT2-4). */
  securityReject?: 'writable-layer-artifact';
}

/** The result of a spot-verification pass (§5.7). */
export interface SpotVerifyResult {
  /** True if a sampled artifact ≠ `transpile(source)` — the section was distrusted. */
  tampered: boolean;
  /** The first mismatching module's app path (for the security event / log). */
  path?: string;
  /** How many modules were sampled (`min(K, |consumed|)`). */
  sampled: number;
  /** What kind of mismatch fired the distrust (§5.7 byte check vs §3 frontmatter). */
  reason?: 'transpile-mismatch' | 'frontmatter-mismatch';
}

/** The confined result of reading the frontmatter sidecar (§1.3). */
export interface MdxMetadataSeedResult {
  /** Absolute `/app/...` path → frontmatter, for entries that pass confinement. */
  entries: Map<string, Record<string, any>>;
  /** True if the sidecar file existed (whether or not any entry was honored). */
  present: boolean;
  /** Set if the sidecar itself sat in the writable (COW) layer → rejected (§3). */
  securityReject?: 'writable-layer-mdx-metadata';
}

/**
 * Runtime consumption of pre-transpiled artifacts (PRETRANSPILED_ARTIFACTS_SPEC
 * §5.1 seeding, §5.3 consult / write-through / reset-delete). Owns the
 * `/transpiled` tmpfs and the per-module dependency records that a seeded
 * (never-live-transpiled) module needs — its deps live in the index, not in the
 * compiled bytes. All validation is delegated to the pure G2-2 core
 * (`artifactIndex.ts`); this class is the I/O wiring around it.
 */
export class ArtifactStore {
  // Raw dep specifiers per module app-path — for seeded modules (from the index)
  // and written-through modules (collected live), so a consult HIT can re-register
  // them without re-running the chain.
  private deps = new Map<string, string[]>();
  // In-flight `/transpiled` deletes, so a consult awaits a racing reset-delete and
  // never reads an entry that is being discarded (§5.3 sequencing).
  private pendingDeletes = new Map<string, Promise<void>>();
  private didSeed = false;
  // App paths actually seeded from the index (the universe spot-verify samples).
  private seededPaths = new Set<string>();
  // App paths a consult actually served from a seeded artifact (the consumed set).
  private consumed = new Set<string>();
  // Set once a spot-verify mismatch (or any §5.7 distrust) fires: the section is
  // discarded for the session — no further consults, no re-seed.
  private distrusted = false;
  // The cache zip's commit (from the sidecar) — reported with a distrust verdict.
  private commitSha: string | null = null;

  constructor(
    private readonly fs: ArtifactFs,
    private readonly embedded: EmbeddedToolchainIdentity,
  ) {}

  /**
   * Seed `/transpiled` from `/app/.immediately.run/artifacts/index.json` (§5.1). Returns
   * the count seeded; a no-op (0) when the index is absent/invalid, the toolchain
   * stamp mismatches, or the readable-layer-only gate fails. Per-file failures
   * (dirty, srcSha mismatch, bad path, …) skip just that file (§5.5).
   */
  async seed(ctx: SeedContext): Promise<SeedResult> {
    // The parent's §5.7 distrust mark for this (coords, commitSha) pre-distrusts
    // the section → seed nothing (the served boot treats artifacts as absent).
    if (this.didSeed || this.distrusted) return { seeded: 0 };
    this.didSeed = true;

    let index: ArtifactIndex | null = null;
    try {
      index = parseArtifactIndex(JSON.parse(await this.fs.readFileAsync(underAppRoot(INDEX_REPO_PATH))));
    } catch {
      return { seeded: 0 };
    }
    if (!index) return { seeded: 0 };
    // §4.4 stamp gate: both version and toolchainHash must match.
    if (!toolchainMatches(index.toolchain, this.embedded)) return { seeded: 0 };

    // §5.1 readable-layer-only (PT2-4): the index, the sidecar, and EVERY artifact
    // file must live in the readable (zip) layer only; any in the writable layer
    // rejects the WHOLE section (a planted artifact could survive a clean Refresh).
    const seedingInputs = [INDEX_REPO_PATH, MANIFEST_SIDECAR_PATH];
    for (const entry of Object.values(index.files)) {
      // `entry.out` is relative to `.immediately.run/artifacts/`; confine it (a `..`
      // entry can't reach a writable-layer file outside the dir) then take its
      // repo-relative form `/<confined>`.
      const confined = outWithinArtifacts(entry.out);
      if (confined) seedingInputs.push(`/${confined}`);
    }
    if (!readableLayerOnly(seedingInputs, ctx.writableLayer)) {
      return { seeded: 0, securityReject: 'writable-layer-artifact' };
    }

    const manifestShas = await this.readManifestShas();
    let seeded = 0;
    for (const [rawKey, entry] of Object.entries(index.files)) {
      const v = validateSeedEntry(rawKey, entry, { manifestShas, dirtySet: ctx.dirtySet });
      if (!v.ok) continue;
      let content: string;
      try {
        // v.out is the confined `.immediately.run/artifacts/...` path; read it from /app.
        content = await this.fs.readFileAsync(underAppRoot(`/${v.out}`));
      } catch {
        continue;
      }
      await this.fs.writeFile(`${TRANSPILED_ROOT}${v.path}.js`, content);
      this.deps.set(underAppRoot(v.path), v.deps);
      this.seededPaths.add(underAppRoot(v.path));
      seeded++;
    }
    return { seeded };
  }

  /**
   * Consult `/transpiled` for an app module (§5.3). HIT → the precompiled bytes +
   * its recorded deps; MISS → null (caller live-transpiles). Awaits any in-flight
   * reset-delete for this path so a re-transform never reads a stale entry.
   */
  async consult(appModulePath: string): Promise<{ content: string; deps: string[] } | null> {
    if (this.distrusted || !isAppModule(appModulePath)) return null;
    const transpiledPath = transpiledPathFor(appModulePath);
    const pending = this.pendingDeletes.get(transpiledPath);
    if (pending) await pending;
    if (!(await this.fs.isFileAsync(transpiledPath))) return null;
    const content = await this.fs.readFileAsync(transpiledPath);
    // Genuinely-served seeded artifacts are the spot-verify universe (§5.7); a
    // written-through module is self-produced and can't be tampered.
    if (this.seededPaths.has(appModulePath)) this.consumed.add(appModulePath);
    return { content, deps: this.deps.get(appModulePath) ?? [] };
  }

  /**
   * Write a live-transpiled module through to `/transpiled` (§5.3 miss path), so an
   * in-session re-read (e.g. after an HMR invalidation cascade that didn't reset
   * THIS module) hits the tmpfs instead of the chain.
   */
  async writeThrough(appModulePath: string, compiled: string, deps: string[]): Promise<void> {
    if (!isAppModule(appModulePath)) return;
    await this.fs.writeFile(transpiledPathFor(appModulePath), compiled);
    this.deps.set(appModulePath, deps);
  }

  /**
   * Drop an app module's `/transpiled` entry (§5.3 reset-delete). Synchronous to
   * call (resetCompilation is sync); the async unlink is tracked so a queued
   * re-transform's `consult` awaits it before reading. A no-op for non-app paths.
   */
  invalidate(appModulePath: string): void {
    if (!isAppModule(appModulePath)) return;
    const transpiledPath = transpiledPathFor(appModulePath);
    this.deps.delete(appModulePath);
    const done = this.fs.deleteFile(transpiledPath).finally(() => {
      if (this.pendingDeletes.get(transpiledPath) === done) {
        this.pendingDeletes.delete(transpiledPath);
      }
    });
    this.pendingDeletes.set(transpiledPath, done);
  }

  private async readManifestShas(): Promise<Map<string, string>> {
    try {
      const raw = await this.fs.readFileAsync(underAppRoot(MANIFEST_SIDECAR_PATH));
      const sidecar = JSON.parse(raw) as {
        entries?: Array<{ path: string; sha: string }>;
        commitSha?: string;
      };
      // Capture the zip's commit so a distrust verdict can name it (§5.7); the
      // parent attributes the mark to the mount it owns.
      if (typeof sidecar.commitSha === 'string') this.commitSha = sidecar.commitSha;
      return manifestShaMap(sidecar.entries ?? []);
    } catch {
      return new Map();
    }
  }

  /** The cache zip's commit, read from the sidecar during seeding (§5.7 key). */
  getCommitSha(): string | null {
    return this.commitSha;
  }

  /**
   * Read + confine the frontmatter sidecar (MDX_CONTENT_COLLECTIONS_SPEC §1.3) so a
   * clean cached boot seeds the metadata store from JSON instead of walking the tree.
   * Returns `present:false` when the sidecar is absent (or the section is distrusted)
   * → the caller live-scans. A writable-layer sidecar is rejected eagerly (§3). Each
   * entry is honored only if it passes the SAME confinement as `§5.1` artifact seeding:
   * a valid repo-relative path that names a manifest `entries[]` member, is not in the
   * dirty set, and whose `srcSha` equals the manifest sha. Keys are translated to the
   * absolute `/app/...` metadata-store space (`metadataKey.test.ts`) before returning.
   */
  async seedMdxMetadata(ctx: SeedContext): Promise<MdxMetadataSeedResult> {
    const absent: MdxMetadataSeedResult = { entries: new Map(), present: false };
    if (this.distrusted) return absent;

    let raw: string;
    try {
      raw = await this.fs.readFileAsync(underAppRoot(MDX_METADATA_REPO_PATH));
    } catch {
      return absent; // sidecar not shipped → live scan (§5.5)
    }
    // §3 readable-layer-only: a writable-layer (COW) sidecar could survive a clean
    // Refresh — reject the section and let the caller distrust + live-scan.
    if (ctx.writableLayer.has(MDX_METADATA_REPO_PATH)) {
      return { entries: new Map(), present: true, securityReject: 'writable-layer-mdx-metadata' };
    }
    let parsed: { schemaVersion?: unknown; files?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { entries: new Map(), present: true };
    }
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.files !== 'object' || parsed.files === null) {
      return { entries: new Map(), present: true };
    }

    const manifestShas = await this.readManifestShas();
    const entries = new Map<string, Record<string, any>>();
    for (const [rawKey, value] of Object.entries(parsed.files as Record<string, unknown>)) {
      const v = value as { srcSha?: unknown; frontmatter?: unknown };
      if (
        typeof v?.srcSha !== 'string' ||
        typeof v?.frontmatter !== 'object' ||
        v.frontmatter === null ||
        Array.isArray(v.frontmatter)
      ) {
        continue;
      }
      const path = normalizeRepoRelPath(rawKey);
      if (!path) continue; // bad/traversing key
      const manifestSha = manifestShas.get(path);
      if (manifestSha === undefined) continue; // not a committed member
      if (ctx.dirtySet.has(path)) continue; // modified → live fallback
      if (v.srcSha !== manifestSha) continue; // source bytes drifted
      const frontmatter = v.frontmatter as Record<string, any>;
      if (Object.keys(frontmatter).length === 0) continue; // empty-frontmatter drop
      entries.set(underAppRoot(path), frontmatter);
    }
    return { entries, present: true };
  }

  /**
   * Pre-distrust the section before boot — the parent sets this from its persisted
   * §5.7 mark for this `(repo coordinates, commitSha)`, so `seed()` no-ops and the
   * boot treats the artifacts as absent until a new commit clears the mark.
   */
  markDistrusted(): void {
    this.distrusted = true;
  }

  /** Number of seeded artifacts actually consulted this session (the §5.7 universe). */
  consumedCount(): number {
    return this.consumed.size;
  }

  /**
   * Mandatory spot-verification (§5.7): re-transpile up to `min(K, |consumed|)`
   * uniformly-random consumed modules through the embedded chain and byte-compare
   * each against the artifact it consumed. ANY mismatch → discard the WHOLE section
   * for the session (`discardAll`) and report tampered. The caller (idle-scheduled)
   * emits the §8.14 security event + the `artifact-distrust` host message.
   */
  async spotVerify(
    k: number = SPOT_VERIFY_K,
    opts?: {
      /** The seeded frontmatter for an app path (§3 extension), or undefined if none. */
      frontmatterOf?: (appModulePath: string) => Record<string, any> | undefined;
    },
  ): Promise<SpotVerifyResult> {
    const universe = [...this.consumed];
    const sample = sampleWithoutReplacement(universe, Math.min(k, universe.length));
    for (const appModulePath of sample) {
      let source: string;
      let consumedArtifact: string;
      try {
        source = await this.fs.readFileAsync(appModulePath);
        consumedArtifact = await this.fs.readFileAsync(transpiledPathFor(appModulePath));
      } catch {
        // The module was reset/evicted since it was consumed — it's live now, not
        // artifact-served; nothing to verify.
        continue;
      }
      const result = await transformFile({ path: appModulePath, code: source });
      if ('error' in result || result.code !== consumedArtifact) {
        this.discardAll();
        return { tampered: true, path: appModulePath, sampled: sample.length, reason: 'transpile-mismatch' };
      }
      // §3 frontmatter extension: `srcSha` binds the source blob, NOT the derived
      // frontmatter the sidecar seeded. Re-derive it from the re-read source (this
      // is the ONLY runtime path that re-reads a covered `.mdx` — verify-on-read is
      // dead on the consult-HIT path) and deep-compare; a mismatch is a forged/divergent
      // sidecar → distrust the section. Same source bytes → same parser output, so no
      // false positive for a benign publisher (the CLI uses this same parser, §1.3).
      const seededFrontmatter = opts?.frontmatterOf?.(appModulePath);
      if (seededFrontmatter !== undefined && appModulePath.endsWith('.mdx')) {
        const liveFrontmatter = parseFrontmatter(source).data;
        if (JSON.stringify(liveFrontmatter) !== JSON.stringify(seededFrontmatter)) {
          this.discardAll();
          return { tampered: true, path: appModulePath, sampled: sample.length, reason: 'frontmatter-mismatch' };
        }
      }
    }
    return { tampered: false, sampled: sample.length };
  }

  /**
   * Discard the whole artifact section for the session (§5.7): delete every
   * consumed `/transpiled` entry and mark distrusted so nothing is re-consumed
   * (consult returns null → live transpile). Returns the discarded app paths so the
   * bundler can re-transpile them live this session.
   */
  discardAll(): string[] {
    const discarded = [...this.consumed];
    this.distrusted = true;
    for (const appModulePath of discarded) this.invalidate(appModulePath);
    this.seededPaths.clear();
    this.consumed.clear();
    return discarded;
  }
}

// Fisher-Yates partial shuffle → a uniform sample of `n` distinct elements.
function sampleWithoutReplacement<T>(items: readonly T[], n: number): T[] {
  const copy = items.slice();
  for (let i = 0; i < n && i < copy.length; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
