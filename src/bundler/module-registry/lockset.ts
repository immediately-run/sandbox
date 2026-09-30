/*
 * Dependency lockset consumption (PRETRANSPILED_ARTIFACTS_SPEC §4.3, §5.4).
 *
 * A cache zip's manifest sidecar may carry a `lockset`: the verbatim
 * /dep_tree response the CLI captured at zip-build time, together with an
 * echo of the exact input DepMap it was resolved for. When the echo matches
 * the DepMap the bundler computes itself, the blocking dep_tree CDN request
 * is skipped. Any mismatch — version, shape, or dependency set — falls back
 * to live resolution; the lockset is a cache, never a source of truth.
 */

import { DepMap } from '.';
import { CDN_VERSION, IResolvedDependency } from './module-cdn';

export interface LocksetSection {
  cdnVersion: number;
  // The input DepMap the lockset was resolved for:
  // filterBuildDeps(augmentDependencies(package.json dependencies)).
  dependencies: DepMap;
  // Verbatim /dep_tree response.
  resolved: IResolvedDependency[];
}

const isDepMap = (value: unknown): value is DepMap =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === 'string');

const isResolvedDependency = (value: unknown): value is IResolvedDependency => {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<IResolvedDependency>;
  return typeof d.n === 'string' && typeof d.v === 'string' && typeof d.d === 'number';
};

/**
 * Structural validation of an untrusted sidecar `lockset` value. Returns the
 * section when well-formed AND resolved against this runtime's CDN protocol
 * version, else null (→ live resolution).
 */
export const validateLockset = (value: unknown): LocksetSection | null => {
  if (!value || typeof value !== 'object') return null;
  const l = value as Partial<LocksetSection>;
  if (l.cdnVersion !== CDN_VERSION) return null;
  if (!isDepMap(l.dependencies)) return null;
  if (!Array.isArray(l.resolved) || !l.resolved.every(isResolvedDependency)) return null;
  return l as LocksetSection;
};

/** Order-independent exact equality of two DepMaps (same keys, same ranges). */
export const depMapsEqual = (a: DepMap, b: DepMap): boolean => {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => b[k] === a[k]);
};

/**
 * R3-844 — the echo-match context for a git-library consumer.
 *
 * The CLI writes its `lockset.dependencies` echo with `computeInputDepMap` over
 * the app's root runtime deps, and that map INCLUDES the app's git-form entries
 * (`"@immediately-run/omnibox": "github:owner/repo#ref"`) — `computeInputDepMap`
 * never strips them. This runtime's own fetch input EXCLUDES them
 * (`registryResolvedNames()`: they resolve from a mounted library under
 * `/node_modules/<name>/`, and `concreteVersion()` cannot answer a git
 * specifier), so the exact-match comparator could never hold for a git-library
 * consumer: the lockset never applied, the boot always needed the CDN, and a
 * CDN outage blanked exactly the apps the library-mount rail serves.
 *
 * The fix (the item's second design option): compare the echo against the
 * PRE-strip map — recomputed here through the same shared `computeInputDepMap`
 * the CLI uses, so the two sides are one function, not mirrored logic — and
 * drop the git names from the APPLIED manifest (they resolve from the mount,
 * never the lockset).
 *
 * Security posture: the echo-match still proves app identity — `echoMap` is
 * computed from THIS runtime's own parsed package.json, not from the sidecar.
 * A sidecar echoing extra names fails against it exactly as before; the only
 * newly tolerated asymmetry (git names present in the echo, absent from the
 * runtime's fetch input) is spelled by the runtime's own git-dependency parse,
 * and those names are REMOVED from the applied manifest, so a forged
 * `github:`-valued echo entry can neither widen the match nor inject a fetch.
 */
export interface LocksetEchoContext {
  /** The pre-strip echo map — `computeInputDepMap` over the root runtime deps,
   *  git entries included; the exact quantity the CLI's echo mirrors. */
  echoMap: DepMap;
  /** The git-form names the runtime stripped from its own fetch input (a subset
   *  of `echoMap`'s keys). Dropped from the applied manifest. */
  gitNames: Set<string>;
}

/**
 * Does the sidecar's dependency echo identify THIS app's dependency declaration?
 * With no echo context: exact equality against the runtime's fetch input (the
 * pre-R3-844 contract). With one: exact equality against the pre-strip map the
 * CLI mirrors — the runtime's fetch input differs from it by exactly the git
 * names (stripped here) and the mounted libraries' contributed deps (derived
 * at runtime, not part of the app's own declaration), neither of which is
 * sidecar-controlled.
 */
export const depMapsEchoMatch = (runtimeDeps: DepMap, lockset: LocksetSection, echo?: LocksetEchoContext): boolean =>
  echo ? depMapsEqual(echo.echoMap, lockset.dependencies) : depMapsEqual(runtimeDeps, lockset.dependencies);

/**
 * Closure check (SPEC_REVIEW PT-2): the echo-match proves the INPUT DepMap is
 * the app's, but NOT that `resolved` is a faithful resolution of it — a lockset
 * could echo the right inputs yet inject extra packages into `resolved`, which
 * `preloadModules` would then fetch. /dep_tree returns a flat DEPTH list (no
 * parent edges), so we enforce what is verifiable network-free:
 *
 *  No injected root — every depth-0 entry must be a declared dependency. A
 *  top-level package the app never declared is the clear injection signal (the
 *  resolved set for a given input is otherwise deterministic).
 *
 * Residual (documented): a package injected at depth > 0 (claiming to be a
 * transitive dep) cannot be refuted without adjacency in /dep_tree. It is inert
 * unless an `import` reaches it (an un-imported fetched module is never
 * evaluated); fully closing it needs a /dep_tree shape that carries edges. We do
 * NOT require completeness (every declared dep present in `resolved`): a missing
 * dep is an app-breakage, not an injection, and /dep_tree's exact set is the
 * runtime's to reproduce — over-rejecting here would only force needless live
 * resolution.
 *
 * Returns true when the lockset may be used; false → fall back to live
 * resolution (the whole lockset is rejected, never partially trusted).
 */
export const locksetClosureValid = (lockset: LocksetSection): boolean => {
  const declared = new Set(Object.keys(lockset.dependencies));
  for (const r of lockset.resolved) {
    if (r.d === 0 && !declared.has(r.n)) return false; // injected top-level package
  }
  return true;
};
