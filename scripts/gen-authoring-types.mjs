// Generates src/services/authoring/bundled-types.generated.ts — the ambient
// `@types` / package declaration files the authoring worker's typecheck needs in
// its VFS, alongside the TypeScript standard library that
// scripts/gen-authoring-libs.mjs emits.
//
// WHY (R3-329): the worker has no filesystem and no node_modules, so before this
// existed EVERY React file returned three unfixable diagnostics — 2307 (cannot find
// module 'react'), 2875 (react/jsx-runtime missing) and 7026 (no
// JSX.IntrinsicElements) — while the agent's system prompt told it to fix reported
// diagnostics before declaring a task done. A verification tool that reports
// phantom failures is worse than an absent one.
//
// CS-1 (input-trust, CLIENT_SERVICES_SPEC §6): the set below is KERNEL-OWNED and
// fixed at build time. A caller supplies file contents only — never a types package
// name, a path, a tsconfig or an `extends`. That is why this is an explicit table
// rather than a resolver walking whatever the request mentions.
//
// This file is GENERATED at build time (a prebuild of `build:authoring-worker`, and
// of `test`/`typecheck`) and gitignored — never checked in (ways_of_working §9), which
// also keeps ~2 MB of declaration text out of the repo.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = join(here, '..', 'node_modules');
const outFile = join(here, '..', 'src', 'services', 'authoring', 'bundled-types.generated.ts');

/**
 * The kernel's bundled type set. `specifier` is the bare import specifier an app
 * writes; `disk` is where the declarations are installed; `virtual` is where they are
 * mounted in the worker's VFS (rooted at `/`, matching the host's currentDirectory).
 *
 * `specifier: null` means "a transitive dependency of another entry, not something an
 * app is expected to import directly" — bundled so the entries above it type-check
 * completely, but not advertised as covered.
 */
/**
 * Resolve a package's declarations, preferring the copy nested under `under` when the
 * dependency tree has one — so the bundled version matches what the depending package
 * was published against rather than whatever npm happened to hoist.
 */
function resolveDisk(pkg, under) {
  const nested = under ? join(nodeModules, under, 'node_modules', pkg) : null;
  return nested && existsSync(nested) ? join(under, 'node_modules', pkg) : pkg;
}

/**
 * The kernel's bundled type set. `specifier` is the bare import specifier an app
 * writes; `disk` is where the declarations are installed; `virtual` is where they are
 * mounted in the worker's VFS (rooted at `/`, matching the host's currentDirectory).
 *
 * `specifier: null` means "a transitive dependency of another entry, not something an
 * app is expected to import directly" — bundled so the entries above it type-check
 * completely, but not advertised as covered.
 */
const PACKAGES = [
  { specifier: 'react', disk: '@types/react', virtual: '/node_modules/@types/react' },
  { specifier: 'react-dom', disk: '@types/react-dom', virtual: '/node_modules/@types/react-dom' },
  {
    specifier: null,
    disk: resolveDisk('csstype', '@types/react'),
    virtual: '/node_modules/csstype',
  },
  {
    specifier: '@immediately-run/sdk',
    disk: '@immediately-run/sdk',
    virtual: '/node_modules/@immediately-run/sdk',
  },
  // The SDK's own declaration files import these; without them the SDK's types
  // silently degrade to `any` (skipLibCheck hides the lib-side error), which would
  // make the SDK entry look bundled while checking nothing.
  {
    specifier: null,
    disk: resolveDisk('@immediately-run/platform-constants', '@immediately-run/sdk'),
    virtual: '/node_modules/@immediately-run/platform-constants',
  },
  {
    specifier: null,
    disk: resolveDisk('@immediately-run/sandbox-protocol', '@immediately-run/sdk'),
    virtual: '/node_modules/@immediately-run/sandbox-protocol',
  },
  {
    specifier: null,
    disk: resolveDisk('react-error-boundary', '@immediately-run/sdk'),
    virtual: '/node_modules/react-error-boundary',
  },
];

// Directories inside a package that are never needed: nested installs (we mount each
// package explicitly) and TypeScript's back-compat copies for versions older than the
// one this repo builds with.
const SKIP_DIRS = new Set(['node_modules', 'ts5.0', 'ts4.9', 'ts4.8']);

/** Collect `*.d.ts` plus `package.json` (needed for `types`/`exports` resolution). */
function collect(diskDir, virtualDir, into) {
  for (const entry of readdirSync(diskDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const diskPath = join(diskDir, entry.name);
    const virtualPath = `${virtualDir}/${entry.name}`;
    if (entry.isDirectory()) collect(diskPath, virtualPath, into);
    else if (entry.name.endsWith('.d.ts') || entry.name === 'package.json') {
      into.set(virtualPath, readFileSync(diskPath, 'utf8'));
    }
  }
}

const files = new Map();
const manifest = [];
for (const pkg of PACKAGES) {
  const diskDir = join(nodeModules, pkg.disk);
  if (!existsSync(diskDir)) {
    throw new Error(
      `gen-authoring-types: ${pkg.disk} is not installed — it is a build-time devDependency of the ` +
        `authoring worker's bundled type set; run npm install`,
    );
  }
  const before = files.size;
  collect(diskDir, pkg.virtual, files);
  if (files.size === before) {
    throw new Error(`gen-authoring-types: ${pkg.disk} contributed no declaration files`);
  }
  const version = JSON.parse(readFileSync(join(diskDir, 'package.json'), 'utf8')).version;
  manifest.push({ specifier: pkg.specifier, disk: pkg.disk, version });
}

// The bare specifiers an app may import and get real checking for. Consumed by
// typecheck.ts to tell "no types bundled for this package" (a coverage note) apart
// from "this import is broken" — see the unresolved-import policy there.
const covered = manifest.filter((m) => m.specifier).map((m) => m.specifier);

const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
const bytes = entries.reduce((n, [, text]) => n + text.length, 0);

const banner =
  '// GENERATED by scripts/gen-authoring-types.mjs — DO NOT EDIT, DO NOT COMMIT.\n' +
  `// Kernel-owned bundled type set (${entries.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB):\n` +
  manifest.map((m) => `//   ${m.disk}@${m.version}`).join('\n') +
  '\n/* eslint-disable */\n';

const body =
  '/** Bare specifiers the bundled set actually provides declarations for. */\n' +
  `export const BUNDLED_TYPE_SPECIFIERS: readonly string[] = ${JSON.stringify(covered)};\n\n` +
  '/** Virtual VFS path → declaration text (or package.json text, for resolution). */\n' +
  'export const BUNDLED_TYPES: Record<string, string> = {\n' +
  entries.map(([path, text]) => `  ${JSON.stringify(path)}: ${JSON.stringify(text)},`).join('\n') +
  '\n};\n';

writeFileSync(outFile, banner + body);
console.log(
  `gen-authoring-types: wrote ${entries.length} files (${(bytes / 1024 / 1024).toFixed(2)} MB) ` +
    `for ${manifest.map((m) => `${m.disk}@${m.version}`).join(', ')} → ${outFile}`,
);
