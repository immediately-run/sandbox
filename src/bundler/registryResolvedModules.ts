import { IPackageJSON } from '../types';

/**
 * Pure parse of `immediately.run`.`resolveFromRegistry` from a raw package.json
 * string (SDK_PACKAGING_SPEC §10, phase 2). Returns the list of local-module
 * names the app opted to resolve from a self-hosted versioned source at its
 * pinned version instead of receiving the injected singleton (see
 * `addLocalModules`). Any malformed input → `[]` (opt out of nothing), so the
 * default injection path is always the safe fallback.
 */
export function parseRegistryResolvedModules(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as IPackageJSON;
    const list = parsed?.['immediately.run']?.resolveFromRegistry;
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Reduce a package.json dependency range to the concrete version dir we publish
 * under `/v/<version>/` on the self-host. Strips a leading range operator
 * (`^`, `~`, `>=`, …) and takes the first `x.y.z[-pre][+build]` token. Returns
 * `undefined` for anything that is not a single pinned-ish version (e.g. a tag,
 * a URL, `*`, or a multi-range), in which case the caller falls back to
 * injection — we can only serve an exact published version from `/v/`.
 *
 * `^0.2.7` → `0.2.7` (the floor; for full determinism apps should pin exact).
 */
export function concreteVersion(range: string | undefined): string | undefined {
  if (typeof range !== 'string') return undefined;
  const trimmed = range.trim().replace(/^[\^~]|^>=|^<=|^>|^<|^=|^v/g, '').trim();
  const m = trimmed.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
  return m ? m[1] : undefined;
}

/** A module to fetch from its self-hosted versioned location instead of injecting. */
export interface RegistryResolution {
  name: string;
  version: string;
  /** `<self-host-base>/v/<version>` — append `/manifest.json` or `/<file>`. */
  baseUrl: string;
}

/**
 * Plan which local modules to resolve from a self-hosted versioned location for
 * this app. A module qualifies when it is (a) opted in via
 * `immediately.run`.`resolveFromRegistry`, (b) has a self-host base configured,
 * and (c) declares a concrete pinned version in `dependencies`. Anything that
 * fails (c) is omitted so the caller injects it as before — never a broken
 * fetch from a guessed URL.
 *
 * Pure + URL-deriving so the whole resolution is unit-testable without a bundler.
 */
export function planRegistryResolution(
  raw: string,
  selfHostBases: Record<string, string>,
): Map<string, RegistryResolution> {
  const plan = new Map<string, RegistryResolution>();
  let parsed: IPackageJSON;
  try {
    parsed = JSON.parse(raw) as IPackageJSON;
  } catch {
    return plan;
  }
  const optedIn = new Set(parseRegistryResolvedModules(raw));
  const deps = parsed?.dependencies ?? {};
  for (const name of optedIn) {
    const base = selfHostBases[name];
    if (!base) continue;
    const version = concreteVersion(deps[name]);
    if (!version) continue;
    plan.set(name, { name, version, baseUrl: `${base.replace(/\/$/, '')}/v/${version}` });
  }
  return plan;
}
