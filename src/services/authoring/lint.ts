// ESLint linting as a same-origin kernel service (CLIENT_SERVICES_SPEC §6,
// authoring-services plan Phase 2). PURE: { files, preset } → diagnostics[].
//
// This is the sharpest CS-1 / R3-107 case: real ESLint loads eslint.config /
// plugins as executable JS. The programmatic `Linter` does NOT read config files —
// you pass it a config OBJECT — so the kernel supplies that object from a FIXED
// preset menu, and the caller never supplies rules, plugins, a parser, or any
// config. The TS parser is bound by the kernel (it is kernel code, not input).
//
// `Linter` is injected (createLinter): jest/Node uses the `eslint` package; the
// Worker build injects the `eslint-linter-browserify` `Linter` (same class).

import { Linter } from 'eslint';
// Namespace import: @typescript-eslint/parser is CJS with `__esModule` and no
// default export, so a default import resolves to `undefined` under some interops
// (jest/babel). The namespace reliably carries `parseForESLint`.
import * as tsParser from '@typescript-eslint/parser';
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
export interface LintResult {
  diagnostics: LintDiag[];
}

// The minimal `Linter` surface used here — so the Worker can inject the browserify
// build and tests stay decoupled from the eslint major.
export interface LinterLike {
  defineParser(name: string, parser: unknown): void;
  verify(code: string, config: unknown, filename?: string): { line: number; column: number; ruleId: string | null; severity: number; message: string }[];
}
export interface LintOptions {
  createLinter?: () => LinterLike;
  tsParser?: unknown;
}

const TS_PARSER = '@authoring/ts-parser';
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
const FORBIDDEN_FIELDS = ['rules', 'plugins', 'parser', 'parserOptions', 'config', 'overrides', 'env', 'globals', 'extends', 'settings'];

const MAX_DIAGS = 200;
const MESSAGE_CAP = 1000;
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function runLint(req: LintRequest, opts: LintOptions = {}): LintResult {
  for (const k of FORBIDDEN_FIELDS) {
    if (hasOwn(req as object, k)) throw new ServiceInputError(`option ${JSON.stringify(k)} is not allowed — lint config is kernel-owned (pick a preset)`);
  }
  const files = validateFiles(req.files);
  const presetName = req.preset === undefined ? 'recommended' : req.preset;
  if (typeof presetName !== 'string' || !hasOwn(PRESETS, presetName)) {
    throw new ServiceInputError(`unknown preset ${JSON.stringify(presetName)} (one of: ${Object.keys(PRESETS).join(', ')})`);
  }

  const linter = (opts.createLinter ?? (() => new Linter() as unknown as LinterLike))();
  linter.defineParser(TS_PARSER, opts.tsParser ?? tsParser);
  const config = { parser: TS_PARSER, parserOptions: PARSER_OPTIONS, rules: PRESETS[presetName] };

  const diagnostics: LintDiag[] = [];
  for (const f of files) {
    if (diagnostics.length >= MAX_DIAGS) break;
    let messages: ReturnType<LinterLike['verify']>;
    try {
      messages = linter.verify(f.content, config, f.path);
    } catch {
      continue; // a parse failure in lint is not fatal — tsc owns syntax errors
    }
    for (const m of messages) {
      if (diagnostics.length >= MAX_DIAGS) break;
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
  return { diagnostics };
}
