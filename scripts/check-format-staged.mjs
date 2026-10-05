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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** One read of the repo's own package.json script — the derivation's producer. */
export function repoScript(name, cwd = process.cwd()) {
  const script = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.[name];
  if (!script) throw new Error(`check-format-staged: package.json has no scripts.${name}`);
  return script;
}

/** The `{ prefix, exts }[]` a `prettier --check "<glob>" …` script scans. */
export function formatGlobsFromScript(script) {
  const m = /^prettier --check\s+((?:"[^"]+"\s*)+)$/.exec(script.trim());
  if (!m) {
    // Anchored tail: a flag between --check and the globs (e.g. --ignore-path)
    // would be DROPPED here while CI's run honours it — a silent hook/CI
    // divergence, so the whole shape refuses, loudly.
    throw new Error(
      `check-format-staged: format:check is not a plain 'prettier --check "<glob>"…' — flags or other args belong in CI, or extend this parser: ${script}`,
    );
  }
  const globs = [...m[1].matchAll(/"([^"]+)"/g)].map((t) => t[1]);
  return globs.map((glob) => {
    const g = /^([\w./-]+)\/\*\*\/\*\.(?:\{([\w,]+)\}|(\w+))$/.exec(glob);
    if (!g || g[1].startsWith('.')) {
      // A './'-prefixed glob parses but can never match a git path (git emits
      // 'src/x.ts', never './src/x.ts') — refuse it rather than match nothing.
      throw new Error(
        `check-format-staged: format:check glob "${glob}" is not the supported 'dir/**/*.ext' / 'dir/**/*.{a,b}' shape (or starts with '.') — extend the matcher or the hook checks nothing`,
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
  // `-z` NUL-terminates and never quotes: without it, core.quotePath C-quotes a
  // non-ASCII staged path ("caf\303\251.ts") and the glob match would drop it
  // while CI's whole-tree sweep still checks it — a hook/CI disagreement.
  const out = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  return out.split('\0').filter(Boolean);
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
    // A non-zero prettier exit is the formatting verdict. Anything else — a
    // spawn failure, a signal kill (the memory-fence class this item exists
    // because of), a bin resolution throw — has no exit status and must surface
    // as the error it is, never as a "not prettier-clean" misdiagnosis.
    if (err != null && typeof err.status === 'number') return err.status;
    throw err;
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
  const realScript = repoScript('format:check');
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

  // The commit-list selection itself (the item's instrumented-list leg): a
  // synthetic ~20-file commit selects exactly the in-scope members.
  const synthetic = [
    ...Array.from({ length: 8 }, (_, i) => `src/mod/a${i}.ts`),
    ...Array.from({ length: 5 }, (_, i) => `src/deep/nested/b${i}.tsx`),
    'scripts/tool.mjs',
    'src/data.json',
    'README.md',
    'docs/guide.md',
    'src/styles.css',
    '.github/workflows/ci.yml',
    'package.json',
  ];
  const selectedDemo = selectFilesToFormat(realScript, synthetic);
  const inScope = synthetic.filter((f) => fileMatchesGlobs(f, globs));
  assert(
    inScope.length > 0 && inScope.length < synthetic.length,
    'the synthetic list has both in- and out-of-scope members',
  );
  assert(
    JSON.stringify(selectedDemo) === JSON.stringify(inScope),
    `the synthetic ${synthetic.length}-file commit selects exactly its ${inScope.length} in-scope members`,
  );

  // A non-conforming script fails loudly, naming where to look.
  let threw = false;
  try {
    formatGlobsFromScript('prettier --write "src/**"');
  } catch (err) {
    threw = /format:check|glob/.test(String(err));
  }
  assert(threw, 'an unrecognized script shape throws (never silently checks nothing)');

  // The runner: a malformed file blocks, a clean one passes (the block-the-commit leg).
  // The fixture dir sits INSIDE the repo so prettier resolves the repo's own
  // config the way the production hook resolves it — in /tmp the default config
  // would answer and a shared-config change could flip the real verdict while
  // this test stayed green. (Not under node_modules: prettier never reads
  // there, config or not.)
  const dir = mkdtempSync(join(process.cwd(), '.fmt-staged-'));
  const good = join(dir, 'good.ts');
  const bad = join(dir, 'bad.ts');
  writeFileSync(good, 'export const a = 1;\n');
  writeFileSync(bad, 'export const a=1\n');
  try {
    assert(runPrettierCheck([good]) === 0, 'a well-formed file passes');
    assert(runPrettierCheck([bad]) !== 0, 'a malformed file fails (the commit is blocked)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const selected = selectFilesToFormat(repoScript('format:check'), stagedFiles());
  if (selected.length === 0) {
    console.log('format(staged): nothing to check');
    process.exit(0);
  }
  const checkable = selected.filter((f) => existsSync(f));
  const gone = selected.filter((f) => !existsSync(f));
  for (const f of gone) console.log(`format(staged): skipping ${f} — staged but deleted from the worktree`);
  if (checkable.length === 0) {
    console.log('format(staged): nothing to check');
    process.exit(0);
  }
  console.log(`format(staged): checking ${checkable.length} changed file(s)`);
  const status = runPrettierCheck(checkable);
  if (status !== 0) {
    console.error('\nformat(staged): the commit’s changed files are not prettier-clean.');
    console.error('Fix with `npx prettier --write <file>`. The whole-tree sweep is CI’s format:check leg.');
  }
  process.exit(status);
}
