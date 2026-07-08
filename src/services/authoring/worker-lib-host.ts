// The typecheck base host for the WORKER runtime (CLIENT_SERVICES_SPEC §6). A
// Worker has no filesystem, so `ts.createCompilerHost` cannot read the standard
// library. This host serves the bundled `lib.*.d.ts` text (embedded at build time
// by scripts/gen-authoring-libs.mjs) so the in-Worker typecheck resolves global
// types (Array, Promise, DOM, JSX, …). Injected into `runTypecheck` as
// `createBaseHost`; the on-disk default stays for Node/jest.

import ts from 'typescript';
import { BUNDLED_LIBS, DEFAULT_LIB } from './bundled-libs.generated';

/** Lib files are looked up by BARE filename, so any path TS constructs for a lib
 *  (however it prefixes the default-lib location) resolves to the bundled text. */
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const libText = (fileName: string): string | undefined => BUNDLED_LIBS[basename(fileName)];

/** A `ts.CompilerHost` backed entirely by the bundled standard library — no fs. The
 *  caller's in-memory source files are layered on top by `inMemoryHost`
 *  (typecheck.ts); anything not a bundled lib and not a caller file simply doesn't
 *  exist (the typecheck scope is open files + the standard lib, by design). */
export function createBundledLibHost(_options: ts.CompilerOptions): ts.CompilerHost {
  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      const text = libText(fileName);
      return text !== undefined
        ? ts.createSourceFile(fileName, text, languageVersionOrOptions, true)
        : undefined;
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
    fileExists: (fileName) => libText(fileName) !== undefined,
    readFile: (fileName) => libText(fileName),
    directoryExists: () => true,
    getDirectories: () => [],
  };
}
