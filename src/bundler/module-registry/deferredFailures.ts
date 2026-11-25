/**
 * R3-1383 — a declared dependency that fails to resolve or preload fails the IMPORT, not the
 * boot. A repo that is mostly a CLI declares packages its page never loads (dibber's
 * `csv-parse`, for its CSV import command), and one of them failing used to abort the whole
 * boot before anything had looked at what the page imports.
 *
 * The failed package is replaced by a stub package whose entry throws the recorded error when
 * it is evaluated, which is the R3-411 pattern (`UNSUPPORTED_BUILTIN_MODULE_PATH`) applied to a
 * top-level package: a page that never imports it boots, and one that does fails at that
 * import with the same message the boot used to show.
 *
 * Pure: the record, the stub package, the warning text and the specifier → package mapping.
 * `ModuleRegistry` owns the state (one record per package name).
 */
import type { ICDNModule } from './module-cdn';
import { parseBareSubpath } from './esm-fallback';

/** One declared package that could not be loaded, and why. */
export interface DeferredFailure {
  readonly name: string;
  /** The range package.json declared. */
  readonly range: string;
  /** The error the boot would have thrown; the stub throws exactly this. */
  readonly message: string;
}

/** Where the stub's entry lives: the same path a package root resolves to. */
export const deferredFailureModulePath = (name: string): string => `/node_modules/${name}/index.js`;

/** The stub's entry: CommonJS that throws the recorded error when evaluated. */
export function deferredFailureSource(failure: DeferredFailure): string {
  return `throw new Error(${JSON.stringify(failure.message)});\n`;
}

/** A synthetic package standing in for the failed one (`package.json` + the throwing entry). */
export function synthesizeDeferredFailureModule(failure: DeferredFailure): ICDNModule {
  return {
    f: {
      'package.json': {
        c: JSON.stringify({ name: failure.name, version: failure.range, main: 'index.js' }),
        d: [],
        t: true,
      },
      'index.js': { c: deferredFailureSource(failure), d: [], t: true },
    },
    m: [],
  };
}

/** The one boot-time warning per deferred package. */
export function deferredFailureWarning(failure: DeferredFailure): string {
  return (
    `"${failure.name}@${failure.range}" could not be loaded, so the page boots without it; ` +
    `anything that imports it fails with: ${failure.message}`
  );
}

/**
 * The package a BARE specifier names (`name`, `name/sub`, `@scope/name`, `@scope/name/sub`), or
 * null for a relative, absolute, `node:` or URL specifier.
 */
export function packageNameOf(specifier: string): string | null {
  const subpath = parseBareSubpath(specifier);
  if (subpath) return subpath.name;
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  const segs = specifier.split('/');
  if (segs[0].startsWith('@')) return segs.length === 2 && segs[1] ? specifier : null;
  return segs.length === 1 && segs[0] ? specifier : null;
}
