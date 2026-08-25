// Prettier formatting as a same-origin kernel service (CLIENT_SERVICES_SPEC §6,
// authoring-services plan Phase 0). PURE: a request of { source, parser, options }
// → formatted string. No state, no fs.
//
// Input-trust (CS-1 / R3-107) is the load-bearing rule here, because prettier
// plugins/configs are executable JS:
//   - the PARSER menu is KERNEL-OWNED — the caller names a parser, never supplies
//     a plugin or a module path;
//   - `options` are a whitelist of SCALAR values, validated one-by-one — never an
//     option object that carries a function, a plugin ref, or a `__proto__` key.

import prettier from 'prettier/standalone';
import parserTypeScript from 'prettier/parser-typescript';
import parserBabel from 'prettier/parser-babel';
import parserPostcss from 'prettier/parser-postcss';

/** Thrown on caller-input violations; mapped to `invalid-params` by the gate (Phase 3). */
export class ServiceInputError extends Error {}

export type FormatParser = 'typescript' | 'babel' | 'json' | 'css';

// Fixed parser → bundled-plugin menu. Adding a parser is a kernel/TCB change.
const PARSER_PLUGINS: Record<FormatParser, unknown[]> = {
  typescript: [parserTypeScript],
  babel: [parserBabel],
  json: [parserBabel], // prettier's `json` parser ships inside parser-babel
  css: [parserPostcss],
};

// The only options a caller may set, each with a value validator. Never an option
// object/function/module — only these scalars.
const OPTION_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  printWidth: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 200,
  tabWidth: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 8,
  useTabs: (v) => typeof v === 'boolean',
  semi: (v) => typeof v === 'boolean',
  singleQuote: (v) => typeof v === 'boolean',
  trailingComma: (v) => v === 'none' || v === 'es5' || v === 'all',
};

const SOURCE_CAP = 512 * 1024; // 512 KB of source per call

export interface FormatRequest {
  source?: unknown;
  parser?: unknown;
  options?: unknown;
}
export interface FormatResult {
  formatted: string;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function sanitizeOptions(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ServiceInputError('options must be an object of scalar values');
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    // hasOwn guard also rejects an injected `__proto__` key (which would otherwise
    // resolve to Object.prototype on the validator lookup).
    if (!hasOwn(OPTION_VALIDATORS, k)) throw new ServiceInputError(`unsupported option ${JSON.stringify(k)}`);
    const v = (raw as Record<string, unknown>)[k];
    if (!OPTION_VALIDATORS[k](v)) throw new ServiceInputError(`invalid value for option ${JSON.stringify(k)}`);
    out[k] = v;
  }
  return out;
}

export function runFormat(req: FormatRequest): FormatResult {
  const { source, parser } = req;
  if (typeof source !== 'string') throw new ServiceInputError('source must be a string');
  if (source.length > SOURCE_CAP) throw new ServiceInputError('source exceeds the size budget');
  if (typeof parser !== 'string' || !hasOwn(PARSER_PLUGINS, parser)) {
    throw new ServiceInputError(
      `unknown parser ${JSON.stringify(parser)} (one of: ${Object.keys(PARSER_PLUGINS).join(', ')})`,
    );
  }
  const options = sanitizeOptions(req.options);
  const formatted = prettier.format(source, {
    parser: parser as FormatParser,
    plugins: PARSER_PLUGINS[parser as FormatParser] as never,
    ...options,
  });
  return { formatted };
}
