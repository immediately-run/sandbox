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
// lib.*.d.ts in a Worker and the on-disk libs under Node (jest). The default
// uses `ts.createCompilerHost`, which works under Node; the Worker passes a host
// backed by bundled lib strings (wired when the Parcel target lands).

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

function validateFiles(raw: unknown): TypecheckFile[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ServiceInputError('files must be a non-empty array');
  if (raw.length > MAX_FILES) throw new ServiceInputError(`too many files (max ${MAX_FILES})`);
  let total = 0;
  const files: TypecheckFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') throw new ServiceInputError('each file must be { path, content }');
    const { path, content } = f as Record<string, unknown>;
    if (typeof path !== 'string' || !path) throw new ServiceInputError('file.path must be a non-empty string');
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

export function runTypecheck(req: TypecheckRequest, opts: TypecheckOptions = {}): TypecheckResult {
  const files = validateFiles(req.files);
  const fileMap = new Map(files.map((f) => [f.path, f.content]));
  const base = (opts.createBaseHost ?? ((o) => ts.createCompilerHost(o, true)))(COMPILER_OPTIONS);
  const host = inMemoryHost(base, fileMap);
  const program = ts.createProgram([...fileMap.keys()], COMPILER_OPTIONS, host);

  const raw = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  const diagnostics: Diag[] = [];
  for (const d of raw) {
    if (diagnostics.length >= MAX_DIAGS) break;
    // Only report diagnostics anchored in the caller's files (skip lib noise).
    if (!d.file || !fileMap.has(d.file.fileName)) continue;
    diagnostics.push({
      path: d.file.fileName,
      start: d.start ?? 0,
      length: d.length ?? 0,
      category: CATEGORY[d.category],
      code: d.code,
      messageText: ts.flattenDiagnosticMessageText(d.messageText, '\n').slice(0, MESSAGE_CAP),
    });
  }
  return { diagnostics };
}
