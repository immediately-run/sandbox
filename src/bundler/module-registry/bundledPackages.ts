// Consume side of R3-49a: read resolved dependency CONTENT bundled into the cache
// zip (by `@immediately-run/cli cache-zip --bundle-packages`) instead of fetching
// each `/package/<name@version>` from the CDN at boot. The bundled bytes are the
// VERBATIM `/package/` msgpack `ICDNModule`, so they decode identically to a live
// fetch. The dependency closure dominates cold boot (`loadNodeModules`, ~99%); this
// turns the per-package CDN fetch into a local read, and (with ZenFS batch hydration,
// R3-49b) a single bulk transfer. See plans/dependency-loading-optimization.md.

import { decode as decodeMsgPack } from '@msgpack/msgpack';
import { underAppRoot } from '../../fsLayout';
import type { ICDNModule } from './module-cdn';

// In-zip layout written by the CLI (mirrors immediately-run-cli/src/commands/cacheZip).
// NB: still under `.tinkerable/` — the planned `.immediately.run/` rename moves the
// whole sidecar (manifest + artifacts + packages) together, so this constant tracks it.
export const BUNDLED_PACKAGES_DIR = '.tinkerable/packages';

/** App-rooted path of the bundled-package index (`{cdnVersion, packages:[{n,v,key,path}]}`). */
export const bundledIndexPath = (): string => underAppRoot(`/${BUNDLED_PACKAGES_DIR}/index.json`);

/** App-rooted path of a bundled package file, given its index `path` (filename). */
export const bundledPackagePath = (relPath: string): string =>
  underAppRoot(`/${BUNDLED_PACKAGES_DIR}/${relPath}`);

interface BundledIndexEntry {
  n: string;
  v: string;
  key: string;
  path: string;
}

/**
 * Parse + validate the bundled-package index. Returns a Map keyed by
 * `name@version` → in-zip filename, or `null` if the payload is absent/malformed
 * (the caller then resolves that package live from the CDN — bundling is a pure
 * accelerator, never a correctness dependency).
 */
export const parseBundledIndex = (raw: string): Map<string, string> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const idx = parsed as { packages?: unknown };
  if (!idx || !Array.isArray(idx.packages)) return null;
  const map = new Map<string, string>();
  for (const e of idx.packages as Partial<BundledIndexEntry>[]) {
    if (e && typeof e.n === 'string' && typeof e.v === 'string' && typeof e.path === 'string') {
      map.set(`${e.n}@${e.v}`, e.path);
    }
  }
  return map;
};

/** Decode verbatim `/package/` msgpack bytes into an `ICDNModule`. */
export const decodeBundledModule = (bytes: Uint8Array): ICDNModule =>
  decodeMsgPack(bytes) as ICDNModule;
