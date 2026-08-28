// In-memory TypeScript typecheck as a same-origin kernel service
// (CLIENT_SERVICES_SPEC §6, authoring-services plan Phase 1). PURE: a set of
// in-memory { path, content } files → diagnostics. Scope is open/changed files
// (LLM_AND_AGENTS §3.2: a whole-project `tsc --build` is the local agent's job).
//
// Input-trust (CS-1 / R3-107): the compilerOptions are KERNEL-OWNED constants —
// the caller supplies file contents only, never a tsconfig / compilerOptions /
// `extends` / module path (a tsconfig can carry executable references).
//
// Lib seam: `createBaseHost` is injected so the SAME code serves the bundled
// lib.*.d.ts + `@types` in a Worker and the on-disk ones under Node (jest). The
// default uses `ts.createCompilerHost`, which works under Node; the Worker passes
// `createBundledLibHost` (worker-lib-host.ts), backed by build-time bundles.
//
// Unresolved imports are a COVERAGE NOTE, not an error (R3-329). The service's scope
// is open/changed files against a fixed kernel type set, so two perfectly ordinary
// situations produce TS2307 through no fault of the code: an app importing a package
// the kernel bundles no types for (`add_dependency` is declare-only, ESM-from-CDN),
// and a file importing a sibling the caller did not include in this request. Reporting
// either as an error is the phantom-diagnostic failure this service already had once —
// the agent is told to fix reported diagnostics before finishing, and it cannot fix
// these. They are reported at `message` severity with text that says what happened,
// so a genuine typo is still visible without being an unsatisfiable instruction.

import ts from 'typescript';
import { ServiceInputError } from './format';

export interface TypecheckFile {
  path: string;
  content: string;
}
export interface Diag {
  path: string;
  start: number;
  length: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  code: number;
  messageText: string;
}
export interface TypecheckRequest {
  files?: unknown;
}
export interface TypecheckResult {
  diagnostics: Diag[];
}
export interface TypecheckOptions {
  /** Injected for the Worker (bundled libs) / overridden in tests. */
  createBaseHost?: (options: ts.CompilerOptions) => ts.CompilerHost;
}

// Kernel-owned compiler options. NOT caller-supplied (CS-1).
const COMPILER_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2020,
  esModuleInterop: true,
  allowJs: true,
  skipLibCheck: true,
};

const MAX_TOTAL_BYTES = 1024 * 1024; // 1 MB across all files per call
const MAX_FILES = 200;
const MAX_DIAGS = 200;
const MESSAGE_CAP = 1000;

const CATEGORY: Record<ts.DiagnosticCategory, Diag['category']> = {
  [ts.DiagnosticCategory.Error]: 'error',
  [ts.DiagnosticCategory.Warning]: 'warning',
  [ts.DiagnosticCategory.Suggestion]: 'suggestion',
  [ts.DiagnosticCategory.Message]: 'message',
};

/** Paths under a `node_modules` segment are RESERVED for the kernel's bundled type
 *  set (worker-lib-host.ts mounts it at `/node_modules/…`). A caller file at one of
 *  those paths would be layered OVER the real declarations by `inMemoryHost` and could
 *  redefine what `react` or the SDK means for its own request — the caller influencing
 *  a kernel-owned input, which is exactly what CS-1 forbids. An app's own source never
 *  lives there, so refusing it costs nothing. */
const isReservedPath = (p: string): boolean => p.split('/').includes('node_modules');

/**
 * Normalize a caller path to the ONE virtual-filesystem spelling the compiler
 * resolves against: rooted at `/`, with `.`/`..`/empty segments collapsed.
 *
 * This is load-bearing, not tidiness. TypeScript's module resolver absolutizes the
 * *containing* file against `getCurrentDirectory()` (`/`) before it joins a relative
 * specifier, while `getSourceFile`/`fileExists` are asked for the raw key the caller
 * supplied. Give it `src/use.ts` and `src/lib.ts` and the two halves disagree: the
 * resolver asks for `/src/lib.ts`, the file map holds `src/lib.ts`, and `./lib`
 * resolves to nothing — so EVERY cross-file type error in the request is invisible
 * and the unresolved-import policy below turns the miss into a reassuring "not an
 * error" note. Repo-relative is exactly what a caller sends (it is what the agent's
 * own `read_file`/`edit_file` paths look like), so the working spelling was the one
 * nobody used. Normalizing both halves to `/…` makes the two agree for either.
 */
export function normalizeFilePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    // `..` above the root is clamped at the root — there is nothing above it in a
    // virtual fs, and silently escaping would be the one outcome worth refusing.
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/** Validate + bound an in-memory `{ path, content }[]` request (shared by lint). */
export function validateFiles(raw: unknown): TypecheckFile[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ServiceInputError('files must be a non-empty array');
  if (raw.length > MAX_FILES) throw new ServiceInputError(`too many files (max ${MAX_FILES})`);
  let total = 0;
  const files: TypecheckFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') throw new ServiceInputError('each file must be { path, content }');
    const { path, content } = f as Record<string, unknown>;
    if (typeof path !== 'string' || !path) throw new ServiceInputError('file.path must be a non-empty string');
    // Check the NORMALIZED path: `src/../node_modules/react/index.d.ts` names the
    // reserved tree just as surely as `/node_modules/react/index.d.ts` does, and only
    // the normalized form is what the compiler would actually be asked for.
    if (isReservedPath(normalizeFilePath(path))) {
      throw new ServiceInputError('file.path must not be under node_modules (reserved for the kernel type set)');
    }
    if (typeof content !== 'string') throw new ServiceInputError('file.content must be a string');
    total += content.length;
    if (total > MAX_TOTAL_BYTES) throw new ServiceInputError('files exceed the size budget');
    files.push({ path, content });
  }
  return files;
}

/** Build a host serving the in-memory files first, lib/everything else from `base`. */
function inMemoryHost(base: ts.CompilerHost, fileMap: Map<string, string>): ts.CompilerHost {
  return {
    ...base,
    getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreate) => {
      const mem = fileMap.get(fileName);
      if (mem !== undefined) return ts.createSourceFile(fileName, mem, languageVersionOrOptions, true);
      return base.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    },
    fileExists: (fileName) => fileMap.has(fileName) || base.fileExists(fileName),
    readFile: (fileName) => (fileMap.has(fileName) ? fileMap.get(fileName) : base.readFile(fileName)),
    writeFile: () => {
      /* noEmit — never writes */
    },
  };
}

/** TS codes meaning "this module specifier did not resolve". */
const UNRESOLVED_MODULE_CODES = new Set([2307, 2792]);

/** The module specifier a diagnostic is anchored on — TS reports 2307 on the string
 *  literal itself, so the span IS the specifier (quotes included). */
function specifierAt(file: ts.SourceFile, start: number, length: number): string | undefined {
  const raw = file.text.slice(start, start + length);
  const m = /^['"](.*)['"]$/.exec(raw);
  return m ? m[1] : undefined;
}

const isRelative = (spec: string): boolean => spec.startsWith('.') || spec.startsWith('/');

/** Rewrite an unresolved-module diagnostic into an honest coverage note, or return
 *  `undefined` to leave the diagnostic exactly as TypeScript reported it. */
function coverageNote(d: ts.Diagnostic, file: ts.SourceFile): Pick<Diag, 'category' | 'messageText'> | undefined {
  if (!UNRESOLVED_MODULE_CODES.has(d.code)) return undefined;
  const spec = specifierAt(file, d.start ?? 0, d.length ?? 0);
  if (spec === undefined) return undefined;
  return {
    category: 'message',
    messageText: isRelative(spec)
      ? `'${spec}' was not included in this typecheck request, so its exports are unchecked. ` +
        `This is not an error: include the file to check it.`
      : `No bundled type declarations for '${spec}', so its exports are unchecked. ` +
        `This is not an error: the typecheck runs against a fixed kernel type set, not node_modules.`,
  };
}

export function runTypecheck(req: TypecheckRequest, opts: TypecheckOptions = {}): TypecheckResult {
  const files = validateFiles(req.files);
  // The program runs on NORMALIZED paths (see `normalizeFilePath`) so the resolver and
  // the file map agree; diagnostics are reported back under the caller's OWN spelling,
  // because a path it did not send is a path it cannot act on.
  const fileMap = new Map<string, string>();
  const asSent = new Map<string, string>();
  for (const f of files) {
    const key = normalizeFilePath(f.path);
    // Two entries normalizing to one file is ambiguous — `src/a.ts` and `/src/a.ts`
    // carry different bytes but name the same module, and silently keeping one would
    // typecheck source the caller never sent.
    const prior = asSent.get(key);
    if (prior !== undefined && prior !== f.path) {
      throw new ServiceInputError(`file.path ${JSON.stringify(f.path)} duplicates ${JSON.stringify(prior)}`);
    }
    fileMap.set(key, f.content);
    asSent.set(key, f.path);
  }
  const base = (opts.createBaseHost ?? ((o) => ts.createCompilerHost(o, true)))(COMPILER_OPTIONS);
  const host = inMemoryHost(base, fileMap);
  const program = ts.createProgram([...fileMap.keys()], COMPILER_OPTIONS, host);

  const raw = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  const diagnostics: Diag[] = [];
  for (const d of raw) {
    if (diagnostics.length >= MAX_DIAGS) break;
    // Only report diagnostics anchored in the caller's files (skip lib noise).
    if (!d.file || !fileMap.has(d.file.fileName)) continue;
    const note = coverageNote(d, d.file);
    diagnostics.push({
      path: asSent.get(d.file.fileName) ?? d.file.fileName,
      start: d.start ?? 0,
      length: d.length ?? 0,
      category: note?.category ?? CATEGORY[d.category],
      code: d.code,
      messageText: (note?.messageText ?? ts.flattenDiagnosticMessageText(d.messageText, '\n')).slice(0, MESSAGE_CAP),
    });
  }
  return { diagnostics };
}
