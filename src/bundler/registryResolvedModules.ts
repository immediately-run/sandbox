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
  const trimmed = range.trim().replace(/^[\^~]|^>=|^<=|^>|^<|^=|^v/g, '').trim();
  const m = trimmed.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
  return m ? m[1] : undefined;
}

/**
 * The self-hosted version to fetch for `moduleName`, given the app's raw
 * package.json (SDK_PACKAGING_SPEC §5, implicit resolution). The app's pinned
 * dependency version wins; anything non-concrete (or an absent declaration)
 * falls back to `defaultVersion` — the version the sandbox guarantees is
 * published — so `@immediately-run/sdk` always resolves with no opt-in needed
 * ("a plain dependency that just works"). Any parse failure → `defaultVersion`.
 */
export function selfHostVersion(
  raw: string,
  moduleName: string,
  defaultVersion: string,
): string {
  try {
    const parsed = JSON.parse(raw) as IPackageJSON;
    return concreteVersion(parsed?.dependencies?.[moduleName]) ?? defaultVersion;
  } catch {
    return defaultVersion;
  }
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
export async function fetchVendoredModule(
  moduleName: string,
  baseUrl: string,
  fetchSource: (url: string) => Promise<string>,
): Promise<VendoredFile[]> {
  const { files } = JSON.parse(await fetchSource(`${baseUrl}/manifest.json`)) as { files: string[] };
  const contents = await Promise.all(files.map((rel) => fetchSource(`${baseUrl}/${rel}`)));
  return files.map((rel, ix) => ({
    path: `/node_modules/${moduleName}/${rel}`,
    content: contents[ix],
    isModule: rel.endsWith('.js'),
  }));
}
