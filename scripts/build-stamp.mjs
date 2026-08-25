#!/usr/bin/env node
// build-stamp.mjs — give the sandbox's built `dist/` a resolvable version stamp (R3-105).
// Appended to `build`, it records what the dist was built from (`srcHash` + `builtAt` +
// package `version`) so `check-freshness` can tell at dev boot whether the served `dist/`
// matches today's `src/` (a stale dist boots old bytes — the file-explorer-panel-race #5
// "stale sandbox dist → slow boot" class). Also gives the otherwise-unversioned local
// build a resolvable identity ("version prebuilt artifacts instead of vendoring").
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STAMP_FILE = '.ir-build-stamp.json';

/** Deterministic content hash of a source tree (order-stable, mtime-independent). */
export function hashSrcDir(srcDir) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === 'dist') continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, `${rel}${name}/`);
      else entries.push(`${rel}${name}\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(srcDir, '');
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const distDir = join(ROOT, 'dist');
  if (!existsSync(distDir)) {
    console.warn('build-stamp: no dist/ — skipped (not built).');
    process.exit(0);
  }
  // Read BOTH from package.json rather than hardcoding the name — it still said
  // 'sandpack-bundler' long after this stopped being that package.
  const { name: pkgName, version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const stamp = { name: pkgName, version, srcHash: hashSrcDir(join(ROOT, 'src')), builtAt: new Date().toISOString() };
  writeFileSync(join(distDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`build-stamp: ${pkgName}@${version} → ${stamp.srcHash.slice(0, 12)}`);
}
