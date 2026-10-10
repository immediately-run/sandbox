// ESLint linting as a same-origin kernel service (CLIENT_SERVICES_SPEC §6,
// authoring-services plan Phase 2). PURE: { files, preset } → diagnostics[].
//
// This is the sharpest CS-1 / R3-107 case: real ESLint loads eslint.config /
// plugins as executable JS. The programmatic `Linter` does NOT read config files —
// you pass it a config OBJECT — so the kernel supplies that object from a FIXED
// preset menu, and the caller never supplies rules, plugins, a parser, or any
// config. The TS parser is bound by the kernel (it is kernel code, not input).
//
// `Linter` + the TS parser are ALWAYS injected — this module deliberately imports
// neither the Node `eslint` package nor `@typescript-eslint/parser` at the top
// level, because both crash a browser Worker on load (Node `eslint` calls
// `url.pathToFileURL`; `@typescript-eslint/parser`'s `typescript-estree` engine
// statically pulls in Node-only `globby`/`fs`). The two runtimes supply their own:
// Node/jest injects `nodeLintDeps` (`./lint-node-deps`); the Worker injects
// `workerLintDeps` (`./worker-lint-host`, the browser `eslint-linter-browserify`
// `Linter` + a browser-safe parser). This mirrors the typecheck lib-host seam
// (`worker-lib-host.ts`).

import { ServiceInputError } from './format';
import { validateFiles } from './typecheck';

export interface LintDiag {
  path: string;
  line: number;
  column: number;
  ruleId: string | null;
  severity: 'error' | 'warning';
  messageText: string;
}
export interface LintRequest {
  files?: unknown;
  preset?: unknown;
}
/** A file the lint pass did not report on, and why (R3-384). Losing a file silently
 *  is worse than losing a diagnostic: the caller believes the file was checked. */
export interface LintSkip {
  path: string;
  /** `parse-error` — the parser threw, so this file produced nothing. `not-reached`
   *  — the diagnostic cap was already full, so the file was never linted at all. */
  reason: 'parse-error' | 'not-reached';
}
export interface LintResult {
  diagnostics: LintDiag[];
  /** `true` when the {@link MAX_DIAGS} cap stopped the list short. */
  truncated: boolean;
  /** Diagnostics produced across every file that WAS linted, emitted or not. Files in
   *  {@link LintResult.skipped} contributed nothing to this, by definition. */
  total: number;
  /** Files that produced no diagnostics because something went wrong, not because
   *  they were clean. Empty is the normal case; a non-empty list means the run is
   *  incomplete and must not render as a clean bill of health. */
  skipped: LintSkip[];
}

// The minimal `Linter` surface used here — so the Worker can inject the browserify
// build and tests stay decoupled from the eslint major. R3-1081: ESLint 9's flat
// config — no defineParser; the parser rides the config object (languageOptions).
export interface LinterLike {
  verify(
    code: string,
    config: unknown,
    filename?: string,
  ): { line: number; column: number; ruleId: string | null; severity: number; message: string; fatal?: boolean }[];
}
// Runtime-supplied linter + parser. REQUIRED — `runLint` has no built-in default so
// this module stays free of any Node-only static import (see the file header).
export interface LintDeps {
  createLinter: () => LinterLike;
  tsParser: unknown;
}

const PARSER_OPTIONS = { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } };

// Fixed, kernel-reviewed rule presets (the eslint analog of the babel-plugin
// registry). Core rules only — no plugin rules, so no plugin code is loaded.
const PRESETS: Record<string, Record<string, unknown>> = {
  recommended: {
    'no-debugger': 'error',
    'no-var': 'error',
    eqeqeq: ['error', 'smart'],
    'no-undef': 'off', // the TS compiler owns undefined-symbol checking
    'prefer-const': 'warn',
    'no-constant-condition': 'warn',
  },
};

// Caller fields that would smuggle executable config — refused outright.
const FORBIDDEN_FIELDS = [
  'rules',
  'plugins',
  'parser',
  'parserOptions',
  'config',
  'overrides',
  'env',
  'globals',
  'extends',
  'settings',
];

const MAX_DIAGS = 200;
const MESSAGE_CAP = 1000;
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function runLint(req: LintRequest, deps: LintDeps): LintResult {
  for (const k of FORBIDDEN_FIELDS) {
    if (hasOwn(req as object, k))
      throw new ServiceInputError(
        `option ${JSON.stringify(k)} is not allowed — lint config is kernel-owned (pick a preset)`,
      );
  }
  const files = validateFiles(req.files);
  const presetName = req.preset === undefined ? 'recommended' : req.preset;
  if (typeof presetName !== 'string' || !hasOwn(PRESETS, presetName)) {
    throw new ServiceInputError(
      `unknown preset ${JSON.stringify(presetName)} (one of: ${Object.keys(PRESETS).join(', ')})`,
    );
  }

  const linter = deps.createLinter();
  // ESLint 9's verify catches EVERY parser throw into a fatal diagnostic, which
  // loses the contract's distinction: a syntax error in the CALLER's code is a
  // diagnostic (tsc owns it, the file was read fine), a parser that CRASHES is a
  // skipped file (the kernel's bug, nothing linted). The wrapper re-marks the
  // crash so the fatal message below still separates them: a syntax error from
  // typescript-estree carries a `location`; a crash does not.
  const parser = {
    parseForESLint: (...args: unknown[]) => {
      try {
        return (deps.tsParser as { parseForESLint: (...a: unknown[]) => unknown }).parseForESLint(...args);
      } catch (e) {
        if (e && typeof e === 'object' && 'location' in e) throw e;
        throw new Error(`PARSER-CRASH: ${(e as Error)?.message ?? String(e)}`);
      }
    },
  };
  // Flat config: a config object without `files` matches NOTHING (ESLint 9) —
  // the service is TS-only by design (the kernel-bound parser), so the matcher
  // is the TS extension set, and a non-TS path reports the no-config diagnostic
  // rather than silently linting as TS.
  const config = {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser, parserOptions: PARSER_OPTIONS },
    rules: PRESETS[presetName],
  };

  const diagnostics: LintDiag[] = [];
  const skipped: LintSkip[] = [];
  let total = 0;
  for (const f of files) {
    // R3-384: the cap used to `break` the FILE loop, so every remaining file went
    // unlinted with no signal — the caller could not tell an unchecked file from a
    // clean one. Record them instead of vanishing them. We stop linting (the parse is
    // the expensive part and the budget is spent) but we say which files that cost.
    if (diagnostics.length >= MAX_DIAGS) {
      skipped.push({ path: f.path, reason: 'not-reached' });
      continue;
    }
    let messages: ReturnType<LinterLike['verify']>;
    try {
      // Flat-config `files` patterns match cwd-RELATIVE paths — a caller's
      // leading-slash path (`/a.ts`) matches nothing and reports the no-config
      // diagnostic instead of linting. Strip it for the match only; the
      // diagnostics carry the caller's own path.
      messages = linter.verify(f.content, config, f.path.replace(/^\/+/, ''));
    } catch {
      // A parse failure is not fatal — tsc owns syntax errors — but it is not nothing
      // either. It was previously a bare `continue`, which reported the file as clean.
      skipped.push({ path: f.path, reason: 'parse-error' });
      continue;
    }
    // ESLint 9's Linter.verify catches a throwing parser and returns the fatal
    // message instead of throwing — the skip contract holds via the wrapper's
    // PARSER-CRASH marker (a caller-side syntax error is a diagnostic, never a
    // skip; a parser crash is a skip, never a clean bill).
    if (messages.some((m) => m.fatal && m.message.startsWith('Parsing error: PARSER-CRASH:'))) {
      skipped.push({ path: f.path, reason: 'parse-error' });
      continue;
    }
    total += messages.length;
    for (const m of messages) {
      if (diagnostics.length >= MAX_DIAGS) continue;
      diagnostics.push({
        path: f.path,
        line: m.line,
        column: m.column,
        ruleId: m.ruleId,
        severity: m.severity === 2 ? 'error' : 'warning',
        messageText: m.message.slice(0, MESSAGE_CAP),
      });
    }
  }
  return { diagnostics, total, truncated: total > diagnostics.length || skipped.length > 0, skipped };
}
