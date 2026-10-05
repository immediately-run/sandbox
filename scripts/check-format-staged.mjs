#!/usr/bin/env node
// check-format-staged.mjs — the pre-commit format check over the COMMIT's files,
// not the tree (R3-951).
//
// Why: the hook used to run `npm run format:check` — prettier --check over the
// whole tree — on every commit, and on 2026-10-05 that scan exceeded a small
// worker's per-command memory fence deterministically (four kills in a row on a
// 4 cpu / 11.7 GiB container). CI's `format:check` remains the whole-tree gate —
// unchanged. This hook is the early warning for the files a commit touches; a
// malformed file nobody touched is CI's catch, not this hook's.
//
// The globs come from package.json's `format:check` script, PARSED — one home,
// so the hook and CI cannot drift. Only the shapes the org's format:check
// scripts use are recognised (`dir/**/*.ext`, `dir/**/*.{a,b}`); anything else
// throws naming the script, so a new glob shape fails loudly at commit time
// rather than silently checking nothing.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The `{ prefix, exts }[]` a `prettier --check "<glob>" …` script scans. */
export function formatGlobsFromScript(script) {
  const m = /^prettier --check\s+(.+)$/.exec(script.trim());
  if (!m) {
    throw new Error(`check-format-staged: format:check is not a plain 'prettier --check <globs>': ${script}`);
  }
  const globs = [...m[1].matchAll(/"([^"]+)"/g)].map((t) => t[1]);
  if (globs.length === 0) {
    throw new Error(`check-format-staged: format:check names no quoted globs: ${script}`);
  }
  return globs.map((glob) => {
    const g = /^([\w./-]+)\/\*\*\/\*\.(?:\{([\w,]+)\}|(\w+))$/.exec(glob);
    if (!g) {
      throw new Error(
        `check-format-staged: format:check glob "${glob}" is not the supported 'dir/**/*.ext' / 'dir/**/*.{a,b}' shape — extend the matcher or the hook checks nothing`,
      );
    }
    return { prefix: g[1], exts: (g[2] ?? g[3]).split(',') };
  });
}

/** Does `file` fall under one of the derived globs? */
export function fileMatchesGlobs(file, globs) {
  return globs.some(({ prefix, exts }) => file.startsWith(`${prefix}/`) && exts.includes(file.split('.').pop()));
}

/** The changed files a commit must format-check: staged paths under the globs. */
export function selectFilesToFormat(scriptText, changedFiles) {
  const globs = formatGlobsFromScript(scriptText);
  return changedFiles.filter((f) => fileMatchesGlobs(f, globs));
}

/** `git diff --cached` — the commit's added/copied/modified/renamed-to paths. */
export function stagedFiles(cwd = process.cwd()) {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

/** The repo's own prettier binary (bin field read from its package.json — the
 *  `.bin` shim name and the internal path differ across prettier versions). */
export function prettierBinPath(cwd = process.cwd()) {
  const req = createRequire(join(cwd, 'noop.js'));
  const pkgJson = req.resolve('prettier/package.json');
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prettier;
  if (!bin) throw new Error(`check-format-staged: ${pkgJson} declares no prettier bin`);
  return join(dirname(pkgJson), bin);
}

/** prettier --check over exactly `files`, through the repo's own prettier. */
export function runPrettierCheck(files, cwd = process.cwd()) {
  try {
    execFileSync(process.execPath, [prettierBinPath(cwd), '--check', ...files], { cwd, stdio: 'inherit' });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

function runSelfTest() {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`self-test: FAIL — ${msg}`);
      process.exitCode = 1;
    } else {
      console.log(`self-test: ok — ${msg}`);
    }
  };

  // The real producer: this repo's own package.json script drives the derivation.
  const realScript = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts['format:check'];
  const globs = formatGlobsFromScript(realScript);
  assert(globs.length > 0, 'the repo’s own format:check globs derive');
  for (const { prefix, exts } of globs) {
    assert(
      fileMatchesGlobs(`${prefix}/deep/dir/example.${exts[0]}`, globs),
      `${prefix}/**/*.${exts[0]} matches a deep member`,
    );
    // '**' spans zero directories too: dir/x.ext must match.
    assert(
      fileMatchesGlobs(`${prefix}/example.${exts[0]}`, globs),
      `${prefix}/**/*.${exts[0]} matches a direct member`,
    );
  }
  assert(!fileMatchesGlobs('README.md', globs), 'README.md is not selected');
  assert(!fileMatchesGlobs('not-a-real-dir/x.ts', globs), 'a path outside every glob prefix is not selected');

  // Brace expansion + single-extension shapes.
  const demo = formatGlobsFromScript('prettier --check "src/**/*.{ts,tsx}" "test/**/*.mjs"');
  assert(fileMatchesGlobs('src/a/b.tsx', demo) && fileMatchesGlobs('test/x.mjs', demo), 'brace + single shapes match');
  assert(!fileMatchesGlobs('test/x.js', demo), 'an unlisted extension does not match');

  // A non-conforming script fails loudly, naming where to look.
  let threw = false;
  try {
    formatGlobsFromScript('prettier --write "src/**"');
  } catch (err) {
    threw = /format:check|glob/.test(String(err));
  }
  assert(threw, 'an unrecognized script shape throws (never silently checks nothing)');

  // The runner: a malformed file blocks, a clean one passes (the block-the-commit leg).
  const dir = mkdtempSync(join(tmpdir(), 'fmt-staged-'));
  const good = join(dir, 'good.ts');
  const bad = join(dir, 'bad.ts');
  writeFileSync(good, 'export const a = 1;\n');
  writeFileSync(bad, 'export const a=1\n');
  assert(runPrettierCheck([good]) === 0, 'a well-formed file passes');
  assert(runPrettierCheck([bad]) !== 0, 'a malformed file fails (the commit is blocked)');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const script = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts['format:check'];
  const selected = selectFilesToFormat(script, stagedFiles());
  if (selected.length === 0) {
    console.log('format(staged): nothing to check');
    process.exit(0);
  }
  console.log(`format(staged): checking ${selected.length} changed file(s)`);
  const status = runPrettierCheck(selected);
  if (status !== 0) {
    console.error('\nformat(staged): the commit’s changed files are not prettier-clean.');
    console.error('Fix with `npx prettier --write <file>`. The whole-tree sweep is CI’s format:check leg.');
  }
  process.exit(status);
}
