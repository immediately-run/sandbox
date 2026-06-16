// R3-49d: CDN-layout fast-path resolution.
//
// The remaining cold-boot cost after the per-compile resolveAsync result cache
// (sandbox #28) is the resolution ALGORITHM running once per distinct edge — ~843
// genuinely-distinct RELATIVE imports (`./x`, `../y`) inside precompiled
// node_modules packages, ≈3.2s on example-blog. Each runs the full gensync
// resolver: parent-dir package.json walk + processPackageJSON + micromatch alias
// matching + extension/index probing. That is pure CPU; the bytes are already
// local (proven: zip-bundle + hydration moved boot 0ms).
//
// But the CDN already ships the COMPLETE file set for every package
// (`NodeModule.files`, keyed package-relative with no leading slash — exactly what
// RegistryFS treats as "file exists" when `files[rel] != null`). So a relative
// import inside a package can be resolved by a direct map lookup with the resolver's
// own extension/index order — NO gensync, NO package.json walk, NO micromatch —
// PROVIDED no package.json alias (browser/exports/alias field) could remap it.
//
// Correctness gate (conservative, provably equivalent to the full resolver):
// a package is fast-path eligible only when EVERY inlined package.json in its file
// map processes to `aliases` whose keys are all just its own `pkgRoot`. That
// `pkgRoot` entry is the main-entry mapping (`module`/`browser`/`main`/`exports.`)
// and fires ONLY for the bare package root, never a relative subpath — so for an
// eligible package, `resolveAlias` is a no-op on every relative candidate and
// resolution reduces to the extension/index file probing this module replicates.
// ANY other alias key (a `browser`/`exports` subpath remap, an `alias` glob)
// makes the package ineligible and we fall through to the real resolver. A
// non-inlined or unparseable package.json is also ineligible (can't verify).
//
// Anything the fast path can't handle returns null → the caller runs the existing
// resolveAsync. Correctness degrades gracefully; it never resolves to a wrong file.

import { NodeModule } from './NodeModule';
import { processPackageJSON } from '../../resolver/utils/pkg-json';
import * as pathUtils from '../../utils/path';

const NODE_MODULES_PREFIX = '/node_modules/';

/**
 * Split an absolute `/node_modules/...` path into its package name and the
 * package-relative remainder (`''` for the package root). Returns null if the
 * path is not under `/node_modules/<pkg>/`. Handles `@scope/name`.
 */
export function parseNodeModulePath(absPath: string): { pkg: string; rel: string } | null {
  if (!absPath.startsWith(NODE_MODULES_PREFIX)) return null;
  const rest = absPath.slice(NODE_MODULES_PREFIX.length);
  if (!rest) return null;
  const segs = rest.split('/');
  let pkg: string;
  let relStart: number;
  if (segs[0].startsWith('@')) {
    if (segs.length < 2 || !segs[1]) return null;
    pkg = `${segs[0]}/${segs[1]}`;
    relStart = 2;
  } else {
    if (!segs[0]) return null;
    pkg = segs[0];
    relStart = 1;
  }
  return { pkg, rel: segs.slice(relStart).join('/') };
}

/**
 * Whether a NodeModule is fast-path eligible: every inlined package.json in its
 * file map has only its own pkgRoot as an alias key (see the module note). The
 * verdict is a pure function of the immutable package content, so callers cache
 * it per package.
 */
export function isFastPathEligible(pkg: string, nodeModule: NodeModule): boolean {
  const pkgRootAbs = NODE_MODULES_PREFIX + pkg; // e.g. /node_modules/@scope/name
  for (const [rel, file] of Object.entries(nodeModule.files)) {
    if (rel !== 'package.json' && !rel.endsWith('/package.json')) continue;
    // A package.json that isn't inlined (number marker) or isn't a string body
    // can't be verified → ineligible (fail safe).
    if (file == null || typeof file !== 'object' || typeof file.c !== 'string') return false;
    const dirRel = rel === 'package.json' ? '' : rel.slice(0, -'/package.json'.length);
    const pkgRoot = dirRel ? pathUtils.join(pkgRootAbs, dirRel) : pkgRootAbs;
    let processed;
    try {
      processed = processPackageJSON(JSON.parse(file.c), pkgRoot);
    } catch {
      return false;
    }
    for (const key of Object.keys(processed.aliases)) {
      if (key !== pkgRoot) return false;
    }
  }
  return true;
}

/**
 * Resolve a RELATIVE specifier imported from a file inside a precompiled
 * node_modules package, directly against the package's known file set — matching
 * the resolver's extension/index order. Returns the absolute resolved path, or
 * null to signal "fall through to the full resolveAsync".
 *
 * `eligibilityCache` memoizes the per-package alias verdict (immutable for the
 * closure); the caller owns it (reset alongside the resolution cache per compile).
 */
export function resolveFromCdnLayout(
  specifier: string,
  filename: string,
  extensions: string[],
  registry: Map<string, NodeModule>,
  eligibilityCache: Map<string, boolean>,
): string | null {
  // Only relative specifiers — bare specifiers cross packages / hit moduleDirectories
  // logic the fast path deliberately leaves to the resolver.
  if (specifier[0] !== '.') return null;
  // The importer must live inside node_modules (this is the precompiled-closure path).
  if (!parseNodeModulePath(filename)) return null;

  // Join like the resolver (resolveFile → pathUtils.join(dir, specifier)).
  const base = pathUtils.join(pathUtils.dirname(filename), specifier);
  const targetParsed = parseNodeModulePath(base);
  if (!targetParsed) return null; // escaped node_modules (e.g. ../../foo) — let the resolver handle it.
  const { pkg, rel: baseRel } = targetParsed;

  const nodeModule = registry.get(pkg);
  if (!nodeModule) return null;

  let eligible = eligibilityCache.get(pkg);
  if (eligible === undefined) {
    eligible = isFastPathEligible(pkg, nodeModule);
    eligibilityCache.set(pkg, eligible);
  }
  if (!eligible) return null;

  const files = nodeModule.files;
  const exists = (relPath: string): boolean => relPath.length > 0 && files[relPath] != null;
  // The resolver prepends '' (exact match) and dedups (normalizeResolverOptions).
  const exts = [...new Set(['', ...extensions])];

  // Phase A — expandFile(base): the path itself with each extension.
  for (const ext of exts) {
    if (exists(baseRel + ext)) return NODE_MODULES_PREFIX + pkg + '/' + baseRel + ext;
  }
  // Phase B — expandFile(base + '/index'): a directory index with each extension.
  const indexRel = baseRel ? `${baseRel}/index` : 'index';
  for (const ext of exts) {
    if (exists(indexRel + ext)) return NODE_MODULES_PREFIX + pkg + '/' + indexRel + ext;
  }
  // No hit — fall through (the resolver may apply its `/index` retry hack or throw).
  return null;
}
