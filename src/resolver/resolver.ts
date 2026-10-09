import gensync from 'gensync';
import micromatch from 'micromatch';

import { ModuleNotFoundError } from '../errors/ModuleNotFound';
import * as pathUtils from '../utils/path';
import { FnIsFile, FnReadFile, getParentDirectories, isFile } from './utils/fs';
import { extractModuleSpecifierParts } from './utils/module-specifier';
import { ProcessedPackageJSON, processPackageJSON } from './utils/pkg-json';
import { ProcessedTSConfig, getPotentialPathsFromTSConfig, processTSConfig } from './utils/tsconfig';

export type ResolverCache = Map<string, any>;

export interface IResolveOptionsInput {
  filename: string;
  extensions: string[];
  isFile: FnIsFile;
  readFile: FnReadFile;
  moduleDirectories?: string[];
  resolverCache?: ResolverCache;
  /**
   * R3-772 (BUNDLE_EMBEDDING §4c.3) — the snapshot chroot. When set (an absolute,
   * normalized root, e.g. the app root of a snapshot-mounted program), module
   * resolution is confined to it: a relative specifier that escapes the root or
   * an absolute specifier outside it fails with ModuleNotFoundError (the
   * resolver's ENOENT), the package.json/tsconfig discovery walks stop at the
   * root (never probing outside it), and a root-`/tsconfig.json` is not read.
   *
   * The bare-specifier PACKAGE channel is not confined by this option: a
   * `node_modules` walk product is dependency content, pinned by the recorded
   * closure at offer time (host-side), not app-authored space content. When the
   * walk enters a package, the recursion RE-CONFINES to that package's root, so
   * a package's own internals resolve within its subtree exactly as before.
   *
   * Callers pass a NORMALIZED absolute root (pathUtils-normal form); the
   * containment check normalizes every candidate before comparing — this is
   * never a prefix test on an unnormalized spelling.
   */
  confineToRoot?: string;
}

interface IResolveOptions extends IResolveOptionsInput {
  moduleDirectories: string[];
  resolverCache: ResolverCache;
}

/** Containment in the confinement root, on an already-normalized absolute path
 *  (`pathUtils.join` output). `/app2/x` is NOT inside `/app`. */
export const isWithinRoot = (root: string, absPath: string): boolean =>
  absPath === root || absPath.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The `…/node_modules/<pkg>` root a file lives in (scoped names included), or
 *  null for a file outside the package channel. The confinement root for a
 *  package's own internals (R3-772): a package's relative imports resolve
 *  WITHIN its subtree — never across packages, never out of node_modules. */
const packageSubtreeRoot = (filename: string): string | null => {
  const marker = '/node_modules/';
  const at = filename.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = filename.slice(at + marker.length);
  const segments = rest.split('/');
  const nameLength = segments[0]?.startsWith('@') ? 2 : 1;
  if (segments.length < nameLength || segments.slice(0, nameLength).some((s) => s === '')) return null;
  return filename.slice(0, at + marker.length) + segments.slice(0, nameLength).join('/');
};

/** The root `filename`'s resolutions are confined to, or null when unconfined. */
const effectiveConfinement = (opts: IResolveOptions): string | null =>
  opts.confineToRoot ? packageSubtreeRoot(opts.filename) ?? opts.confineToRoot : null;

function normalizeResolverOptions(opts: IResolveOptionsInput): IResolveOptions {
  const normalizedModuleDirectories: Set<string> = opts.moduleDirectories
    ? new Set(opts.moduleDirectories.map((p) => (p[0] === '/' ? p.substring(1) : p)))
    : new Set();
  normalizedModuleDirectories.add('node_modules');

  return {
    filename: opts.filename,
    extensions: [...new Set(['', ...opts.extensions])],
    isFile: opts.isFile,
    readFile: opts.readFile,
    moduleDirectories: [...normalizedModuleDirectories],
    resolverCache: opts.resolverCache || new Map(),
    // Normal form for the root: absolute, `.`/`..` resolved, and NO trailing
    // slash — pathUtils.normalize preserves one ('/app/'), which would stop the
    // discovery walk one level early and break isWithinRoot(root, root).
    ...(opts.confineToRoot
      ? { confineToRoot: pathUtils.normalize(opts.confineToRoot).replace(/\/+$/, '') || '/' }
      : {}),
  };
}

interface IFoundPackageJSON {
  filepath: string;
  content: ProcessedPackageJSON;
}

function* loadPackageJSON(
  filepath: string,
  opts: IResolveOptions,
  // The walk floor: under confinement the walk stops at the importer's
  // EFFECTIVE root (the app root, or the package's own subtree when resolving
  // a package's internals — otherwise an entered package's own manifest would
  // be skipped and its main/browser/alias fields silently lost). A parent
  // package.json ABOVE the floor is never read (§4c.3, review 3S-7: every read
  // the resolver performs for resolution is confined, not only the resolved
  // module paths).
  rootDir: string = effectiveConfinement(opts) ?? '/',
): Generator<any, IFoundPackageJSON | null, any> {
  const directories = getParentDirectories(filepath, rootDir);
  for (const directory of directories) {
    // Boundary-safe floor: getParentDirectories' prefix test admits a
    // prefix-sharing sibling of the floor (`/app2` under `/app`,
    // `/node_modules/react2` under `/node_modules/react`) — such a directory is
    // outside the floor and its manifest is never read (§4c.3, 3S-7, when the
    // floor is the confinement root; hygiene for any other).
    if (!isWithinRoot(rootDir, directory)) continue; // eslint-disable-line no-continue
    const packageFilePath = pathUtils.join(directory, 'package.json');
    let packageContent = opts.resolverCache.get(packageFilePath);
    if (packageContent === undefined) {
      try {
        packageContent = processPackageJSON(
          JSON.parse(yield* opts.readFile(packageFilePath)),
          pathUtils.dirname(packageFilePath),
        );
        opts.resolverCache.set(packageFilePath, packageContent);
      } catch (err) {
        opts.resolverCache.set(packageFilePath, false);
      }
    }
    if (packageContent) {
      return {
        filepath: packageFilePath,
        content: packageContent,
      };
    }
  }
  return null;
}

function resolveFile(filepath: string, dir: string): string {
  switch (filepath[0]) {
    case '.':
      return pathUtils.join(dir, filepath);
    case '/':
      return filepath;
    default:
      // is a node module
      return filepath;
  }
}

function resolveAlias(pkgJson: IFoundPackageJSON, filename: string): string {
  const aliases = pkgJson.content.aliases;

  let relativeFilepath = filename;
  let aliasedPath = relativeFilepath;
  let count = 0;
  do {
    relativeFilepath = aliasedPath;

    // Simply check to ensure we don't infinitely alias files due to a misconfiguration of a package/user
    if (count > 5) {
      throw new Error('Could not resolve file due to a cyclic alias');
    }
    count++;

    // Check for direct matches
    if (aliases[relativeFilepath]) {
      aliasedPath = aliases[relativeFilepath];
      continue;
    }

    for (const aliasKey of Object.keys(aliases)) {
      if (!aliasKey.includes('*')) {
        continue;
      }

      const re = micromatch.makeRe(aliasKey, { capture: true });
      if (re.test(relativeFilepath)) {
        const val = aliases[aliasKey];
        aliasedPath = relativeFilepath.replace(re, val);
        if (aliasedPath.startsWith(relativeFilepath)) {
          const newAddition = aliasedPath.substr(relativeFilepath.length);
          if (!newAddition.includes('/') && relativeFilepath.endsWith(newAddition)) {
            aliasedPath = relativeFilepath;
          }
        }
        break;
      }
    }

    // No new aliased path
    break;
  } while (relativeFilepath !== aliasedPath);

  return aliasedPath || relativeFilepath;
}

function* resolveModule(moduleSpecifier: string, opts: IResolveOptions): Generator<any, string, any> {
  const dirPath = pathUtils.dirname(opts.filename);
  const filename = resolveFile(moduleSpecifier, dirPath);
  const isAbsoluteFilename = filename[0] === '/';
  const pkgJson = yield* findPackageJSON(isAbsoluteFilename ? filename : opts.filename, opts);
  return resolveAlias(pkgJson, filename);
}

function* resolveNodeModule(moduleSpecifier: string, opts: IResolveOptions): Generator<any, string, any> {
  const pkgSpecifierParts = extractModuleSpecifierParts(moduleSpecifier);
  const directories = getParentDirectories(opts.filename);
  for (const modulesPath of opts.moduleDirectories) {
    for (const directory of directories) {
      const rootDir = pathUtils.join(directory, modulesPath, pkgSpecifierParts.pkgName);

      try {
        const pkgFilePath = pathUtils.join(rootDir, pkgSpecifierParts.filepath);
        const pkgJson = yield* loadPackageJSON(pkgFilePath, opts, rootDir);
        if (pkgJson) {
          try {
            // No explicit re-confinement here: resolve()'s effective root is
            // derived from the importer's filename, and `pkgJson.filepath`
            // sits inside this package's subtree — so package internals
            // confine to the package, automatically.
            return yield* resolver(pkgFilePath, {
              ...opts,
              filename: pkgJson.filepath,
            });
          } catch (err) {
            if (!pkgSpecifierParts.filepath) {
              return yield* resolver(pathUtils.join(pkgFilePath, 'index'), {
                ...opts,
                filename: pkgJson.filepath,
              });
            }

            throw err;
          }
        }
      } catch (err) {
        // Handle multiple duplicates of a node_module across the tree
        if (directory.length > 1) {
          return yield* resolveNodeModule(moduleSpecifier, {
            ...opts,
            filename: pathUtils.dirname(directory),
          });
        }

        throw err;
      }
    }
  }
  throw new ModuleNotFoundError(moduleSpecifier, opts.filename);
}

function* findPackageJSON(filepath: string, opts: IResolveOptions): Generator<any, IFoundPackageJSON, any> {
  let pkg = yield* loadPackageJSON(filepath, opts);
  if (!pkg) {
    pkg = yield* loadPackageJSON('/index', opts);
    if (!pkg) {
      return {
        filepath: '/package.json',
        content: {
          aliases: {},
        },
      };
    }
  }
  return pkg;
}

function* expandFile(
  filepath: string,
  opts: IResolveOptions,
  expandCount: number = 0,
): Generator<any, string | null, any> {
  const pkg = yield* findPackageJSON(filepath, opts);

  if (expandCount > 5) {
    throw new Error('Cyclic alias detected');
  }

  for (const ext of opts.extensions) {
    const f = filepath + ext;
    const aliasedPath = resolveAlias(pkg, f);
    if (aliasedPath === f) {
      // R3-772: under confinement an outside-root candidate is not probed at
      // all — the read itself is confined (§4c.3, 3S-7), so a hostile
      // `browser`/`alias` remap cannot reach outside bytes, not even as an
      // existence oracle. The root is the importer's effective root (the app
      // root, or the package's own subtree for package internals). The
      // candidate is normalized BEFORE the check: an alias value like
      // '/app/../firestore/x.js' is returned verbatim by
      // normalizeAliasFilePath and would pass a raw prefix test.
      const confineRoot = effectiveConfinement(opts);
      if (confineRoot && !isWithinRoot(confineRoot, pathUtils.normalize(f))) {
        continue; // eslint-disable-line no-continue
      }
      const exists = yield* isFile(f, opts.isFile);
      if (exists) {
        return f;
      }
    } else {
      const expanded = yield* expandFile(aliasedPath, { ...opts, extensions: [''] }, expandCount + 1);
      if (expanded) {
        return expanded;
      }
    }
  }
  return null;
}

export function normalizeModuleSpecifier(specifier: string): string {
  // R3-411: map the `node:` builtin prefix onto the bare name, so `node:fs`
  // resolves exactly like `fs` (→ the bundler's preloaded shim under
  // `/node_modules/fs`). Node itself treats the two spellings as the same
  // module; packages increasingly use the prefixed form (e.g. Emscripten's
  // guarded `require("node:fs")` in sql.js), which previously fell through to
  // "no such package" because no npm package can be named `node:*`. A `node:`
  // prefix on a NON-builtin still resolves as the bare name would (broken
  // caller code, unchanged outcome).
  const unprefixed = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  const normalized = unprefixed.replace(/(\/|\\)+/g, '/');
  if (normalized.endsWith('/')) {
    return normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

const TS_CONFIG_CACHE_KEY = '__root_tsconfig';
function* getTSConfig(opts: IResolveOptions): Generator<any, ProcessedTSConfig | false, any> {
  // R3-772: `/tsconfig.json` sits at the FILESYSTEM root — outside any
  // confinement root — so a confined resolution does not read it (3S-7). A
  // snapshot program's path mappings are therefore unsupported; the import
  // fails as unresolved rather than resolving through an outside-root map.
  if (opts.confineToRoot) {
    return false;
  }
  const cachedConfig = opts.resolverCache.get(TS_CONFIG_CACHE_KEY);
  if (cachedConfig != null) {
    return cachedConfig;
  }

  let config: ProcessedTSConfig | false = false;
  try {
    const contents = yield* opts.readFile('/tsconfig.json');
    const processed = processTSConfig(contents);
    if (processed) {
      config = processed;
    }
  } catch (err) {
    try {
      const contents = yield* opts.readFile('/jsconfig.json');
      const processed = processTSConfig(contents);
      if (processed) {
        config = processed;
      }
    } catch {
      // do nothing
    }
  }
  opts.resolverCache.set(TS_CONFIG_CACHE_KEY, config);
  return config;
}

export const resolver = gensync<(moduleSpecifier: string, inputOpts: IResolveOptionsInput) => string>(function* resolve(
  moduleSpecifier,
  inputOpts,
): Generator<any, string, any> {
  const normalizedSpecifier = normalizeModuleSpecifier(moduleSpecifier);
  const opts = normalizeResolverOptions(inputOpts);
  const modulePath = yield* resolveModule(normalizedSpecifier, opts);

  // R3-772 (BUNDLE_EMBEDDING §4c.3) — the chroot: for a snapshot-mounted
  // program, a module resolution that leaves its confinement root — a `..`
  // escape (`../../firestore/x`), an absolute specifier (`/repository/x`), or an
  // alias remap landing outside — is ENOENT, BEFORE any probe touches the path.
  // The root is PER-IMPORTER: an app file confines to the app root; a file
  // inside a `node_modules` package confines to that package's own subtree
  // (dependency content is pinned by the host-side closure, not app-authored
  // space content — but a package still cannot reach OUT of its subtree).
  if (opts.confineToRoot && modulePath[0] === '/') {
    const effectiveRoot = packageSubtreeRoot(opts.filename) ?? opts.confineToRoot;
    // Normalize BEFORE comparing: resolveFile returns a '/'-leading specifier
    // verbatim, so '/app/../firestore/x' would otherwise pass the containment
    // check on its string prefix (the item's "never a prefix test on an
    // unnormalized spelling" rule).
    if (!isWithinRoot(effectiveRoot, pathUtils.normalize(modulePath))) {
      throw new ModuleNotFoundError(normalizedSpecifier, opts.filename);
    }
  }

  if (modulePath[0] !== '/') {
    // This isn't a node module, we can attempt to resolve using a tsconfig/jsconfig
    if (!opts.filename.includes('/node_modules')) {
      const parsedTSConfig = yield* getTSConfig(opts);
      if (parsedTSConfig) {
        const potentialPaths = getPotentialPathsFromTSConfig(modulePath, parsedTSConfig);
        for (const potentialPath of potentialPaths) {
          try {
            return yield* resolve(potentialPath, opts);
          } catch {
            // do nothing, it's probably a node_module in this case
          }
        }
      }
    }

    try {
      return yield* resolveNodeModule(modulePath, opts);
    } catch (e) {
      throw new ModuleNotFoundError(normalizedSpecifier, opts.filename);
    }
  }

  let foundFile = yield* expandFile(modulePath, opts);
  if (!foundFile) {
    foundFile = yield* expandFile(pathUtils.join(modulePath, 'index'), opts);

    // In case alias adds an extension, we retry the entire resolution with an added /index
    // This is mostly a hack I guess, but it works for now, so many edge-cases
    if (!foundFile) {
      try {
        const parts = moduleSpecifier.split('/');
        if (!parts.length || !parts[parts.length - 1].startsWith('index')) {
          foundFile = yield* resolve(moduleSpecifier + '/index', opts);
        }
      } catch (err) {
        // should throw ModuleNotFound for original specifier, not new one
      }
    }
  }

  if (!foundFile) {
    throw new ModuleNotFoundError(modulePath, opts.filename);
  }

  return foundFile;
});

export const resolveSync = resolver.sync;
export const resolveAsync = resolver.async;
