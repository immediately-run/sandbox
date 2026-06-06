import { IPackageJSON } from '../types';

/**
 * Pure parse of `immediatelyRun.resolveFromRegistry` from a raw package.json
 * string (SDK_PACKAGING_SPEC §10, phase 2). Returns the list of local-module
 * names the app opted to resolve from the CDN registry at its pinned version
 * instead of receiving the injected singleton (see `addLocalModules`). Any
 * malformed input → `[]` (opt out of nothing), so the default injection path is
 * always the safe fallback.
 */
export function parseRegistryResolvedModules(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as IPackageJSON;
    const list = parsed?.immediatelyRun?.resolveFromRegistry;
    return Array.isArray(list) ? list.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}
