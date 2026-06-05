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
