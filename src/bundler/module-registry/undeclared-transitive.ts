// R3-1203 — the dist-declared transitive rescue.
//
// A caret-ranged direct dependency resolves, live, to whatever the package CDN's
// mirror has newest — which can drift from the app's own lockfile pin. When the
// drifted-to version is one whose DIST imports a package its package.json does
// not declare (the recorded case: @codemirror/language@6.13.0's dist imports
// @codemirror/streamparser, declared only from 6.13.1 on), the /dep_tree answer
// — which walks DECLARED dependencies — never includes that package, the CDN has
// not indexed it either (it postdates the mirror), and the boot dies with
// `Cannot find module '<name>' from '/node_modules/<parent>/dist/index.js'`
// before the app renders anything.
//
// The registry therefore reconciles, after the manifest's own packages load,
// every bare specifier the loaded packages' metadata ACTUALLY names (`m`, the
// CDN's package-level import list) against what it can resolve: a name nobody
// declared, nobody indexed, and nothing registers is routed through the SAME
// esm.sh fallback a dropped top-level dep takes (esm.sh tracks npm in near real
// time, so a package the primary mirror has not ingested is there). The rescue
// is version-independent by construction — it keys on the dist's real imports,
// not on any particular version — so the app boots at editor@main AND at any
// older digest. The unpkg registry mirror is NOT usable for this from the
// sandbox: the opaque-origin iframe cannot follow unpkg's version-resolving
// redirect (its 302 carries no ACAO header; only exact-version URLs are
// CORS-clean), while esm.sh resolves ranges server-side and is already on the
// CSP allowlist.
//
// Failure degrades, never throws: an unresolvable name is warned about and left
// alone, so a guarded require in a file the app never imports keeps the R3-411
// behaviour (the pre-existing module-not-found surfaces exactly if, and only
// when, that import is actually reached).

import { normalizeModuleSpecifier } from '../../resolver/resolver';
import { extractModuleSpecifierParts } from '../../resolver/utils/module-specifier';
import { NODE_SHIMMED_BUILTIN_NAMES } from '../shims';
import { NodeModule } from './NodeModule';

/**
 * How many undeclared packages one boot may rescue. Bounds the boot's esm.sh
 * round-trips against package metadata that names unbounded unknowns — the
 * network budget a hostile or just weird package could otherwise spend. Names
 * past the budget are warned about and left to the ordinary module-not-found
 * path if actually imported.
 */
export const UNDECLARED_IMPORT_RESCUE_BUDGET = 20;

/** One bare specifier some loaded package's metadata names that nothing resolves. */
export interface UndeclaredImport {
  /** The bare package name (`@scope/name`), subpath stripped. */
  name: string;
  /** The registered package whose metadata named it. */
  importer: string;
}

const SHIMMED = new Set(NODE_SHIMMED_BUILTIN_NAMES);

/**
 * Every bare package name the loaded packages' metadata (`NodeModule.modules`,
 * the CDN's package-level import list) names that no already-resolved source
 * covers. `known` is the caller's resolved-name set — the manifest's names,
 * every registered package, and the registry-resolved names (self-hosted bases
 * and git-form mounts). Relative/absolute specifiers, `node:`-prefixed builtins
 * (the shims and the R3-411 stub own those), the shimmed builtin names, and a
 * package's self-reference are not candidates.
 */
export function collectUndeclaredImports(
  modules: Map<string, NodeModule>,
  known: ReadonlySet<string>,
): UndeclaredImport[] {
  const seen = new Set<string>();
  const out: UndeclaredImport[] = [];
  for (const [moduleName, nodeModule] of modules) {
    for (const spec of nodeModule.modules) {
      if (spec.startsWith('node:')) continue; // a builtin spelling — shims/stubs own it
      const normalized = normalizeModuleSpecifier(spec);
      if (normalized === '' || normalized.startsWith('.') || normalized.startsWith('/')) continue;
      const { pkgName } = extractModuleSpecifierParts(normalized);
      if (!pkgName || pkgName === moduleName) continue; // self-reference is legal npm
      if (SHIMMED.has(pkgName)) continue;
      if (known.has(pkgName) || seen.has(pkgName)) continue;
      seen.add(pkgName);
      out.push({ name: pkgName, importer: moduleName });
    }
  }
  return out;
}
