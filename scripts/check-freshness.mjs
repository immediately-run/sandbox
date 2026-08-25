#!/usr/bin/env node
// check-freshness.mjs — fail loud at dev boot when the sandbox's built `dist/` predates
// its `src/` (R3-105; ways_of_working §7). Wired as `predev`, so `npm run dev` refuses to
// serve a stale bundle (the "stale sandbox dist → slow boot" class) with an actionable
// message instead of silently serving old bytes. `dist/` is gitignored + hand-rebuilt
// (`npm run build`); this turns "I forgot to rebuild" from a slow mystery into a fast error.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_FILE = '.ir-build-stamp.json';

/** The package's own name, so a rename cannot leave this log line lying. */
const pkgName = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;

function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist' || name === STAMP_FILE) continue;
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else newest = Math.max(newest, st.mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

/** `'ok'` | `'stale'` | `'unbuilt'` for a built package dir, comparing the newest `src/`
 *  mtime against the stamp's `builtAt` (else newest `dist/` mtime). */
export function freshnessOf(pkgDir) {
  const distDir = join(pkgDir, 'dist');
  if (!existsSync(distDir)) return { status: 'unbuilt' };
  const srcMtime = newestMtime(join(pkgDir, 'src'));
  const stampPath = join(distDir, STAMP_FILE);
  let ref;
  let version;
  if (existsSync(stampPath)) {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    ref = Date.parse(stamp.builtAt);
    version = stamp.version;
  } else {
    ref = newestMtime(distDir);
  }
  return { status: srcMtime > ref ? 'stale' : 'ok', version };
}

async function selfTest() {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const tmp = mkdtempSync(join(os.tmpdir(), 'sbx-fresh-'));
  const pkg = join(tmp, 'pkg');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 1;\n');
  const unbuilt = freshnessOf(pkg).status;
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', STAMP_FILE), JSON.stringify({ version: '0', builtAt: '2000-01-01T00:00:00.000Z' }));
  const stale = freshnessOf(pkg).status;
  writeFileSync(join(pkg, 'dist', STAMP_FILE), JSON.stringify({ version: '0', builtAt: '2999-01-01T00:00:00.000Z' }));
  const ok = freshnessOf(pkg).status;
  rmSync(tmp, { recursive: true, force: true });
  const pass = unbuilt === 'unbuilt' && stale === 'stale' && ok === 'ok';
  console.log(`self-test: unbuilt=${unbuilt} stale=${stale} ok=${ok} → ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

function check() {
  const { status, version } = freshnessOf(ROOT);
  if (status === 'ok') {
    console.log(`sandbox-freshness: ${pkgName()}${version ? `@${version}` : ''} OK.`);
    return;
  }
  console.error(`\n  ✗ Stale sandbox build: dist/ ${status === 'unbuilt' ? 'has never been built' : 'is older than src/'}.`);
  console.error('  Rebuild before serving:  npm run build\n');
  process.exit(1);
}

if (process.argv.includes('--self-test')) await selfTest();
else check();
