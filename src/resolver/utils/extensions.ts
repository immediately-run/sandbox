// R3-577 — the importer-aware extension order.
//
// The default order tries `.js` before `.cjs` for EVERY importer. That is wrong for
// exactly one class: a `.cjs` file whose build tool emitted an EXTENSIONLESS internal
// require (`require("./Omnibox")` in tsup/esbuild dual output). Node-mode CJS interop
// (`__toESM(require(...), 1)`) is only correct when that require meets the CJS sibling
// — meeting the ESM `.js` build instead hands the interop wrapper `{__esModule,
// default}` to consumers where the value belongs (surfaced 2026-09-08 by R3-567's live
// acceptance: React received the module object for a component. R3-565's 2026-09-06
// outage was the sibling defect in the same neighbourhood — a dependency's CSS
// evaluated as JS — whose chain ran through this same extensionless require).
//
// Node's own CJS resolver never tries `.cjs` for an extensionless require, which is
// why the emitters consider the shape safe; this runtime is not node, and here the
// importer-aware order is what makes the emitted shape mean what it means on node.

/**
 * The bundler's default extension order — the ONE canonical spelling (R3-577 review:
 * the literal had five hand-typed copies across bundler.ts and the test suites, and a
 * future reorder of the production default would leave every test copy silently
 * pinning the old order). Tests that mean "the pre-fix order" keep a hand-typed
 * literal as frozen data on purpose, so a default change cannot silently defang them.
 */
export const DEFAULT_EXTENSIONS: string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mdx'];

/**
 * The extension order for an import issued FROM `importerFilename`: the default list
 * unchanged, except that a `.cjs` importer tries `.cjs` FIRST. Every other importer
 * (and any extension list not containing `.cjs`) gets the input order back verbatim.
 */
export function importerAwareExtensions(importerFilename: string, extensions: string[]): string[] {
  if (!importerFilename.endsWith('.cjs')) return extensions;
  if (!extensions.includes('.cjs') || extensions[0] === '.cjs') return extensions;
  return ['.cjs', ...extensions.filter((e) => e !== '.cjs')];
}
