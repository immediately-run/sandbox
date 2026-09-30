// R3-577 — the importer-aware extension order.
//
// The default order tries `.js` before `.cjs` for EVERY importer. That is wrong for
// exactly one class: a `.cjs` file whose build tool emitted an EXTENSIONLESS internal
// require (`require("./Omnibox")` in tsup/esbuild dual output). Node-mode CJS interop
// (`__toESM(require(...), 1)`) is only correct when that require meets the CJS sibling
// — meeting the ESM `.js` build instead hands the interop wrapper `{__esModule,
// default}` to consumers where the value belongs (the 2026-09-06 front-door outage's
// mechanism: React received the module object for a component).
//
// Node's own CJS resolver never tries `.cjs` for an extensionless require, which is
// why the emitters consider the shape safe; this runtime is not node, and here the
// importer-aware order is what makes the emitted shape mean what it means on node.

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
