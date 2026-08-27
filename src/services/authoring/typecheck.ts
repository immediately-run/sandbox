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
  /** R3-384. `true` when {@link MAX_DIAGS} stopped the list short of what the
   *  compiler actually reported. Without it a caller receiving exactly `MAX_DIAGS`
   *  entries cannot tell "that was all" from "200 of 1,400" — and a consumer whose
   *  contract is that a truncated run may never render as a clean bill of health
   *  cannot honour it for a truncation it cannot see. */
  truncated: boolean;
  /** How many diagnostics the caller's files produced in total, whether or not they
   *  were emitted. Counting is cheap — the program has already computed them; only
   *  the formatting above the cap is skipped. */
  total: number;
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

/** The TypeScript standard library is ALSO a kernel-owned input, and it is reachable
 *  by a different route than the type set — so the `node_modules` rule above does not
 *  cover it.
 *
 *  `worker-lib-host` resolves libs by **bare basename** (whatever path TypeScript
 *  constructs for a lib, only its filename is looked up), while `inMemoryHost` answers
 *  from the CALLER's file map first. So a submitted file named `lib.es2020.full.d.ts`
 *  — at any directory, since only the basename is compared — replaces the standard
 *  library for that request, and a genuine error can be silenced by redefining the
 *  type it was reported against. Measured, with a control:
 *
 *      CONTROL (lib doctored so one symbol errors, no shadow):
 *        [ "Property 'POISONED' does not exist on type 'Console'." ]
 *      SHADOWED (a file named lib.es2020.full.d.ts in the request):
 *        []
 *
 *  Not code execution — the residual is INTEGRITY, not RCE — but it is the same CS-1
 *  violation the `node_modules` rule exists to prevent: the caller influencing a
 *  kernel-owned input. It matters more the moment the submitted set stops being
 *  agent-chosen: a panel that enumerates the working tree submits whatever is there,
 *  and under dispatch that tree is a foreign corpus, so a hostile repository could
 *  make its own diagnostics read clean.
 *
 *  The rule is TypeScript's own default-lib naming convention (`lib.<target>.d.ts`)
 *  rather than a membership test against `BUNDLED_LIBS`, for two reasons: this module
 *  deliberately does not import the generated bundle (the lib host is an injected seam
 *  so the same code serves a Worker and Node), and a pattern is strictly broader than
 *  the current set, so it stays correct when the bundled closure changes. No app's own
 *  source is named this way, so refusing it costs nothing. */
const RESERVED_LIB_BASENAME = /^lib\..*\.d\.ts$/i;
const isReservedLibPath = (p: string): boolean => RESERVED_LIB_BASENAME.test(p.slice(p.lastIndexOf('/') + 1));

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
    // Both reserved-path checks run on the NORMALIZED path: `src/../node_modules/react/index.d.ts`
    // names the reserved tree as surely as the rooted spelling, and only the normalized form is
    // what the compiler would actually be asked for.
    const normalized = normalizeFilePath(path);
    if (isReservedPath(normalized)) {
      throw new ServiceInputError('file.path must not be under node_modules (reserved for the kernel type set)');
    }
    if (isReservedLibPath(normalized)) {
      throw new ServiceInputError('file.path must not be named lib.*.d.ts (reserved for the kernel standard library)');
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
  // R3-384: keep counting past the cap. The loop no longer BREAKS on MAX_DIAGS — it
  // stops *emitting* and keeps tallying, so `total` is the honest number and
  // `truncated` is derivable. The saved work above the cap was never the compiler
  // (the diagnostics are already computed by the time `raw` exists); it was only the
  // message flattening and the object allocation, which is what stays skipped.
  let total = 0;
  for (const d of raw) {
    // Only report diagnostics anchored in the caller's files (skip lib noise).
    if (!d.file || !fileMap.has(d.file.fileName)) continue;
    total += 1;
    if (diagnostics.length >= MAX_DIAGS) continue;
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
  return { diagnostics, total, truncated: total > diagnostics.length };
}
