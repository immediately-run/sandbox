import { ICDNModule, IResolvedDependency } from './module-cdn';

// esm.sh fallback for packages the primary dependency CDN (blazingly.io) cannot
// resolve — most often a version newer than its npm mirror has ingested. esm.sh
// tracks npm in near real time, so it covers the gap. We load the dropped
// package as a native ES module (esm.sh emits standalone ESM that links its own
// dependencies via absolute esm.sh URLs) and bridge it into the bundler's
// CommonJS module graph through a synthetic single-file package (see
// `synthesizeEsmFallbackModule`).
//
// React identity — KNOWN LIMITATION (live-verified 2026-06-23). A fallback
// package gets React from esm.sh, i.e. a DISTINCT instance from the
// bundler-resolved app React. React elements and forwardRef objects interop fine
// across instances (their `$$typeof` are realm-global `Symbol.for` symbols), but
// any package that calls a HOOK against its own React breaks: the renderer (app
// react-dom) only sets the APP React's hook dispatcher, so the fallback React's
// dispatcher is null during render → "Cannot read properties of null (reading
// 'useContext')". This was confirmed end to end with lucide-react@1.x, whose
// icons read an internal `IconContext` via `useContext` — so even an "icon set"
// is NOT hook-free in practice. Making this correct for React component libraries
// requires sharing the app's React instance (an import map mapping `react` to a
// shim over the bundler-evaluated React + esm.sh `?external=react`). Until that
// bridge exists, the fallback is DISABLED by default in the registry (a dropped
// package yields the clear `assertDependenciesResolved` error, which is more
// actionable than a broken render).

export type EsmFallbackLoader = (url: string) => Promise<Record<string, unknown>>;

// Native dynamic import of an arbitrary URL. Built through `new Function` so the
// build-time bundler (Parcel) never tries to statically resolve the specifier —
// it must stay a pure runtime import. `unsafe-eval` is already required by the
// module evaluator (`module/eval.ts`).
//
// CSP: no change required today. The sandbox document (sandbox.immediately.run)
// ships no Content-Security-Policy, and this is a direct cross-origin module load
// from the iframe (NOT a parent-forwarded fetch), so neither the sandbox nor the
// host `connect-src` gates it — only CORS does, and esm.sh sends
// `access-control-allow-origin: *` (verified live from an opaque-origin
// allow-scripts iframe). If a CSP is ever added to the sandbox origin, it must
// list `https://esm.sh` in `script-src` AND `connect-src`.
const runtimeImport = new Function('u', 'return import(u);') as (url: string) => Promise<Record<string, unknown>>;
export const nativeEsmFallbackLoader: EsmFallbackLoader = (url) => runtimeImport(url);

const ESM_CDN_ROOT = 'https://esm.sh/';

// The global the registry stashes loaded namespaces on, keyed by package name,
// and the shim reads back. Shared name so both sides agree.
export const ESM_FALLBACK_GLOBAL = '__irEsmFallback';

// Build the esm.sh URL for a dropped package. The primary-resolved react /
// react-dom versions are pinned via `?deps=` so esm.sh links the fallback
// against the same React VERSION the app runs (still a distinct instance — see
// the React-identity caveat above), keeping element/forwardRef shapes aligned.
export function esmFallbackUrl(name: string, range: string, resolved: IResolvedDependency[]): string {
  const pins = ['react', 'react-dom']
    .map((dep) => resolved.find((d) => d.n === dep))
    .filter((d): d is IResolvedDependency => d != null)
    .map((d) => `${d.n}@${d.v}`);
  const query = pins.length ? `?deps=${pins.join(',')}` : '';
  return `${ESM_CDN_ROOT}${name}@${range}${query}`;
}

// CommonJS entry for the synthetic package: re-export the live ES-module
// namespace the registry stashed on the global. The `__esModule` marker plus a
// copied `default` make both named (`import { Search }`) and default
// (`import Lucide`) imports interop correctly through the swc require helpers.
export function esmFallbackShim(name: string): string {
  const key = JSON.stringify(name);
  const globalKey = JSON.stringify(ESM_FALLBACK_GLOBAL);
  return [
    "'use strict';",
    `var __ns = (global[${globalKey}] || {})[${key}];`,
    `if (!__ns) { throw new Error('esm.sh fallback module ' + ${key} + ' was not preloaded'); }`,
    "Object.defineProperty(exports, '__esModule', { value: true });",
    "for (var __k in __ns) { if (__k !== '__esModule') { exports[__k] = __ns[__k]; } }",
    'if (__ns.default !== undefined && exports.default === undefined) { exports.default = __ns.default; }',
  ].join('\n');
}

// Shape a dropped package as an `ICDNModule` so it flows through the normal
// NodeModule → RegistryFS → resolution path with no special-casing downstream.
// `t: true` (precompiled) keeps the shim out of the transpiler; `d: []` means no
// further deps to resolve — esm.sh already linked the package's own subtree.
export function synthesizeEsmFallbackModule(name: string, range: string): ICDNModule {
  return {
    f: {
      'package.json': { c: JSON.stringify({ name, version: range, main: 'index.js' }), d: [], t: true },
      'index.js': { c: esmFallbackShim(name), d: [], t: true },
    },
    m: [],
  };
}
