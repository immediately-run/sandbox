import { browserExcludedPackages } from '@immediately-run/transpiler';

import { APP_ROOT } from '../../fsLayout';
import { normalizeAliasFilePath } from './alias';
import { EMPTY_SHIM } from './constants';
import { extractPathFromExport } from './exports';

// alias/exports/main keys, sorted from high to low priority
const MAIN_PKG_FIELDS = ['module', 'browser', 'main', 'jsnext:main'];
const PKG_ALIAS_FIELDS = ['browser', 'alias'];

type AliasesDict = { [key: string]: string };

export interface ProcessedPackageJSON {
  aliases: AliasesDict;
}

export function processPackageJSON(content: any, pkgRoot: string): ProcessedPackageJSON {
  if (!content || typeof content !== 'object') {
    return { aliases: {} };
  }

  const aliases: AliasesDict = {};
  for (const mainField of MAIN_PKG_FIELDS) {
    if (typeof content[mainField] === 'string') {
      aliases[pkgRoot] = normalizeAliasFilePath(content[mainField], pkgRoot);
      break;
    }
  }

  if (content.browser === false) {
    aliases[pkgRoot] = EMPTY_SHIM;
  }

  // R3-1384: the packages the ROOT package.json's `browser` maps to `false`, by the
  // transpiler's one rule: the same set `rootRuntimeDependencies` leaves out of the dependency
  // map, so the package is never fetched and no subpath of it could resolve. A dependency's
  // own `"util": false` keeps npm's exact-specifier meaning (`util/util.js` still resolves).
  // The app's own manifest only: a mounted library (`/mnt/<hash>`) or a nested package.json
  // is not the root whose exclusions left the package out of the manifest.
  const isRootPackage = pkgRoot === APP_ROOT;
  const excludedPackages = isRootPackage ? browserExcludedPackages(content) : new Set<string>();
  for (const aliasFieldKey of PKG_ALIAS_FIELDS) {
    const aliasField = content[aliasFieldKey];
    if (typeof aliasField === 'object') {
      for (const key of Object.keys(aliasField)) {
        const val = aliasField[key] || EMPTY_SHIM;
        const normalizedKey = normalizeAliasFilePath(key, pkgRoot, false);
        const normalizedValue = normalizeAliasFilePath(val, pkgRoot, false);
        aliases[normalizedKey] = normalizedValue;

        if (aliasFieldKey !== 'browser') {
          aliases[`${normalizedKey}/*`] = `${normalizedValue}/$1`;
        } else if (excludedPackages.has(key)) {
          // R3-1384: a root `"browser": { "csv-parse": false }` removes the whole package, so
          // its subpaths at any depth (`csv-parse/sync`, `csv-parse/lib/sync`) land on the empty shim too. Path keys
          // (`"./src/node.js": false`) name one file and get no wildcard.
          aliases[`${normalizedKey}/**`] = EMPTY_SHIM;
        }
      }
    }
  }

  // load exports if it's not the root pkg.json
  if (content.exports && pkgRoot !== '/') {
    if (typeof content.exports === 'string') {
      aliases[pkgRoot] = normalizeAliasFilePath(content.exports, pkgRoot);
    } else if (typeof content.exports === 'object') {
      for (const exportKey of Object.keys(content.exports)) {
        const exportValue = extractPathFromExport(content.exports[exportKey], pkgRoot);
        const normalizedKey = normalizeAliasFilePath(exportKey, pkgRoot);
        aliases[normalizedKey] = exportValue || EMPTY_SHIM;
      }
    }
  }

  return { aliases };
}
