import { IPackageJSON } from '../types';

/**
 * Reduce a package.json dependency range to the concrete version dir we publish
 * under `/v/<version>/` on the self-host. Strips a leading range operator
 * (`^`, `~`, `>=`, …) and takes the first `x.y.z[-pre][+build]` token. Returns
 * `undefined` for anything that is not a single pinned-ish version (e.g. a tag,
 * a URL, `*`, or a multi-range), in which case the caller falls back to the
 * sandbox's default version — we can only serve an exact published version.
 *
 * `^0.2.7` → `0.2.7` (the floor; for full determinism apps should pin exact).
 */
export function concreteVersion(range: string | undefined): string | undefined {
  if (typeof range !== 'string') return undefined;
  const trimmed = range
    .trim()
    .replace(/^[\^~]|^>=|^<=|^>|^<|^=|^v/g, '')
    .trim();
  const m = trimmed.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
  return m ? m[1] : undefined;
}

/**
 * A self-host resolution failure that must surface to the user as a boot error
 * (SDK_PACKAGING_SPEC §5.1 "Resolution failure semantics"): resolution FAILS
 * CLOSED — we never silently substitute a different version, because an app
 * author who pinned X must get X or a clear error, not Y (that aliasing is the
 * exact bug implicit per-app resolution exists to fix).
 */
export class SelfHostResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfHostResolutionError';
  }
}

/**
 * Minimal semver comparison for floor checks: numeric major.minor.patch, with
 * any prerelease ordering below its release (`0.2.8-beta < 0.2.8`). Build
 * metadata is ignored. Sufficient for comparing two concrete versions; not a
 * general range evaluator.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('+')[0].split(/-(.*)/s);
    const nums = core.split('.').map((n) => parseInt(n, 10));
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa.nums[i] ?? 0) !== (pb.nums[i] ?? 0)) return (pa.nums[i] ?? 0) < (pb.nums[i] ?? 0) ? -1 : 1;
  }
  // Same numeric triple: a prerelease sorts below the plain release.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/**
 * The self-hosted version to fetch for `moduleName`, given the app's raw
 * package.json (SDK_PACKAGING_SPEC §5/§5.1, implicit resolution).
 *
 * - The app's concrete pinned version wins — but a pin below `floor` FAILS
 *   CLOSED (`SelfHostResolutionError`) at resolve time rather than booting
 *   into a known-broken runtime (the 0.2.7 import-cycle crash).
 * - A declared but non-concrete specifier (`latest`, `*`, multi-ranges) also
 *   FAILS CLOSED: implicit self-host resolution serves exact published
 *   versions only, and silently substituting `defaultVersion` would alias the
 *   author's declared intent (§5.1(c): the default applies ONLY when the app
 *   declares no dependency at all).
 * - No declaration → `defaultVersion` ("a plain dependency that just works").
 * - Unparseable package.json → `defaultVersion` (intent unknowable here; a
 *   truly broken package.json fails the boot later in processPackageJSON).
 */
export function resolveSelfHostVersion(raw: string, moduleName: string, defaultVersion: string, floor: string): string {
  let parsed: IPackageJSON | undefined;
  try {
    parsed = JSON.parse(raw) as IPackageJSON;
  } catch {
    return defaultVersion;
  }
  const declared = parsed?.dependencies?.[moduleName];
  if (declared === undefined) {
    return defaultVersion;
  }
  const version = concreteVersion(declared);
  if (version === undefined) {
    throw new SelfHostResolutionError(
      `This app declares ${moduleName}@"${declared}", which is not a concrete version. ` +
        `Self-hosted resolution serves exact published versions only — pin one ` +
        `(e.g. "${defaultVersion}") in package.json. ` +
        `(SDK_PACKAGING_SPEC §5.1: resolution fails closed, never silently substitutes.)`,
    );
  }
  if (compareSemver(version, floor) < 0) {
    throw new SelfHostResolutionError(
      `This app requires ${moduleName}@${version}, which is below the supported ` +
        `floor ${floor} (older versions are known-broken at boot). ` +
        `Update the pin to ${floor} or newer. ` +
        `(SDK_PACKAGING_SPEC §5.1: resolution fails closed at resolve time.)`,
    );
  }
  return version;
}

/** One file resolved for a self-hosted module, ready to write + register. */
export interface VendoredFile {
  /** Absolute in-sandbox path: `/node_modules/<moduleName>/<rel>`. */
  path: string;
  content: string;
  /** `.js` files are registered as bundler Modules; others (package.json) only written. */
  isModule: boolean;
}

/**
 * Fetch a module's `manifest.json` from `baseUrl` and then every file it lists,
 * mapping each to its in-sandbox `/node_modules/<moduleName>/<rel>` path. The
 * manifest is generated alongside the files (the SDK release CI's
 * build-selfhost.mjs), so its list cannot drift from the directory contents.
 *
 * Pure but for the injected `fetchSource`, so the manifest-driven fetch + path
 * derivation is unit-testable without a bundler.
 */
/** Optional sub-phase timing sink for `[ir-perf:addlocal]` boot profiling
 *  (LOAD_PROFILING_SPEC §2 phase 3). Accumulated across modules; never affects
 *  behaviour. */
export interface VendorTiming {
  manifestMs: number;
  filesMs: number;
  fileCount: number;
  verifyMs: number;
  writeMs: number;
}

const vendorNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

export async function fetchVendoredModule(
  moduleName: string,
  baseUrl: string,
  fetchSource: (url: string, integrity?: string) => Promise<string>,
  /** Per-file expected `sha384-…` (the host pin for this version), so the fetch
   *  layer's immutable cache can verify before caching + evict stale hits
   *  (cache-poisoning prevention). Keyed by the same rel paths as the manifest
   *  (incl. `manifest.json`). Omitted when the host wired no pin for the version. */
  expected?: Record<string, string>,
  /** Boot-profiling sink (optional); accumulates manifest- vs files-fetch ms. */
  timing?: VendorTiming,
): Promise<VendoredFile[]> {
  const toVendored = (rel: string, content: string): VendoredFile => ({
    path: `/node_modules/${moduleName}/${rel}`,
    content,
    // `manifest.json` (and any non-`.js`) is written but not registered as a Module.
    isModule: rel.endsWith('.js'),
  });
  const unavailable = (): never => {
    // A pinned version that 404s (or is unreachable) FAILS CLOSED with a clear
    // boot error — never a silent fallback to another version
    // (SDK_PACKAGING_SPEC §5.1(a)).
    throw new SelfHostResolutionError(
      `This app requires ${moduleName} from ${baseUrl}/, which is unavailable ` +
        `(missing or unreachable). The pinned version may not be published to the ` +
        `self-hosted origin. Fix the pin in package.json or publish the version. ` +
        `(SDK_PACKAGING_SPEC §5.1: resolution fails closed, no fallback.)`,
    );
  };

  // FAST PATH — the host pinned this version (`expected` provided). The pin's keys
  // ARE the authoritative file list (`manifest.json` + every module file), so fetch
  // them all in ONE parallel batch and skip the serial `manifest.json`-first
  // round-trip that otherwise gates boot on a cold cross-origin connection — the
  // dominant `addLocalModules` cost (LOAD_PROFILING_SPEC §2 phase 3:
  // manifestFetch ~332ms cold vs the parallel file batch ~19ms). It's also a small
  // security win: the trusted pin — not the fetched manifest's `files` array —
  // decides what gets fetched, so a tampered manifest can't influence the fetch set
  // (every file, manifest included, is hash-verified downstream regardless).
  if (expected) {
    const rels = Object.keys(expected);
    const tFiles0 = vendorNow();
    let contents: string[];
    try {
      contents = await Promise.all(rels.map((rel) => fetchSource(`${baseUrl}/${rel}`, expected[rel])));
    } catch (err) {
      unavailable();
    }
    if (timing) {
      // manifestMs stays 0 — there is no serial manifest round-trip on this path.
      timing.filesMs += vendorNow() - tFiles0;
      timing.fileCount += rels.length;
    }
    return rels.map((rel, ix) => toVendored(rel, contents![ix]));
  }

  // SLOW PATH — unpinned (standalone / no host integrity wired). We don't know the
  // file list ahead of time, so fetch `manifest.json` first to learn it, then the
  // files. (The manifest is still vendored: `verifyVendoredFiles` — when integrity
  // is later wired — requires every pinned file present, and the manifest doesn't
  // list itself in `files`.)
  let manifestRaw: string;
  const tManifest0 = vendorNow();
  try {
    manifestRaw = await fetchSource(`${baseUrl}/manifest.json`);
  } catch (err) {
    unavailable();
  }
  const tManifest1 = vendorNow();
  const { files } = JSON.parse(manifestRaw!) as { files: string[] };
  const contents = await Promise.all(files.map((rel) => fetchSource(`${baseUrl}/${rel}`)));
  const tFiles1 = vendorNow();
  if (timing) {
    timing.manifestMs += tManifest1 - tManifest0;
    timing.filesMs += tFiles1 - tManifest1;
    timing.fileCount += files.length;
  }
  const vendored = files.map((rel, ix) => toVendored(rel, contents[ix]));
  vendored.unshift(toVendored('manifest.json', manifestRaw!));
  return vendored;
}
