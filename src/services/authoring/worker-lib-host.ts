// The typecheck base host for the WORKER runtime (CLIENT_SERVICES_SPEC §6). A
// Worker has no filesystem, so `ts.createCompilerHost` cannot read the standard
// library — nor the `@types` an ordinary React app resolves through node_modules.
// This host serves both from build-time bundles: the `lib.*.d.ts` closure embedded
// by scripts/gen-authoring-libs.mjs, and the kernel-owned type set embedded by
// scripts/gen-authoring-types.mjs. Injected into `runTypecheck` as `createBaseHost`;
// the on-disk default stays for Node/jest.
//
// R3-329: before the type set existed this host served libs only, so every React
// file returned 2307 / 2875 / 7026 — three diagnostics no edit could clear, on a
// tool whose whole job is telling the agent what to fix.

import ts from 'typescript';
import { BUNDLED_LIBS, DEFAULT_LIB } from './bundled-libs.generated';
import { BUNDLED_TYPES } from './bundled-types.generated';

/** Lib files are looked up by BARE filename, so any path TS constructs for a lib
 *  (however it prefixes the default-lib location) resolves to the bundled text. */
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const libText = (fileName: string): string | undefined => BUNDLED_LIBS[basename(fileName)];

/** Declaration/`package.json` files are looked up by their FULL virtual path — they
 *  are a real (if in-memory) node_modules tree, and TypeScript's module resolution
 *  walks it path by path. */
const typeText = (fileName: string): string | undefined => BUNDLED_TYPES[fileName];

const bundledText = (fileName: string): string | undefined => libText(fileName) ?? typeText(fileName);

/** A `ts.CompilerHost` backed entirely by build-time bundles — no fs. The caller's
 *  in-memory source files are layered on top by `inMemoryHost` (typecheck.ts);
 *  anything that is neither a bundled lib, nor part of the bundled type set, nor a
 *  caller file simply doesn't exist — which is the honest answer, and the one
 *  `runTypecheck` turns into a coverage note rather than an error. */
export function createBundledLibHost(_options: ts.CompilerOptions): ts.CompilerHost {
  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      const text = bundledText(fileName);
      return text !== undefined ? ts.createSourceFile(fileName, text, languageVersionOrOptions, true) : undefined;
    },
    // The primary lib TS loads unless `noLib`. Its `/// <reference lib=… />`s pull in
    // the rest of the closure, each resolved back here by basename.
    getDefaultLibFileName: () => DEFAULT_LIB,
    getDefaultLibLocation: () => '',
    writeFile: () => {
      /* noEmit */
    },
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => bundledText(fileName) !== undefined,
    readFile: (fileName) => bundledText(fileName),
    // Deliberately permissive, and load-bearing: TypeScript probes directory paths
    // (including trailing-slash forms like `/node_modules/@types/react/`, which a
    // bare `"./"` re-export inside @types/react produces) before it probes files.
    // A precise implementation that missed one of those spellings silently broke
    // `export { JSX } from "./"` and put 7026 back. `fileExists` is the real gate.
    directoryExists: () => true,
    // No automatic `@types` inclusion: the bundled declarations are reached through
    // ordinary module resolution from the caller's imports, not injected as globals.
    getDirectories: () => [],
  };
}
