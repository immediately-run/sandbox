#!/usr/bin/env node
// check-lock-version.mjs — R3-868: package.json's `version` must equal BOTH of
// package-lock.json's version fields (the root and `packages[""]`).
//
// The failure this exists for. A version bump that rides a feature PR touches
// only package.json; npm does not rewrite the lock's own version fields unless
// an install runs, and `npm ci` tolerates the mismatch (probed on npm 11: exit
// 0). The lock then lies about what the tree claims to be, with no failure
// mode anywhere: this happened in platform-constants (manifest 0.13.0, lock
// 0.12.1), grove (0.1.8/0.1.7, the bump in #79) and dev-fs (0.5.0/0.4.0), each
// found by hand by the R3-678 review gate rather than by any check — because
// `check:publish-version` (where it exists) compares the manifest against the
// npm registry, never against the lock.
//
// The fix command is always the same: `npm install --package-lock-only`, which
// rewrites the lock's version fields from the manifest without touching
// node_modules.
//
// Copied, not shared — the rule is ~30 lines, and a shared package for it
// would itself be a cross-repo dependency to coordinate (the
// check-dependency-pins.mjs precedent).
//
// Run: `node scripts/check-lock-version.mjs`           → exit 1 on a mismatch
//      `node scripts/check-lock-version.mjs --self-test` → prove it can fail
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkLockVersion({ pkg, lock, cwd = '.' }) {
  const problems = [];
  const manifestVersion = pkg?.version;
  if (typeof manifestVersion !== 'string' || manifestVersion.length === 0) {
    problems.push(`${cwd}/package.json has no version field — nothing to sync the lock against.`);
    return problems;
  }
  if (lock?.version !== manifestVersion) {
    problems.push(
      `${cwd}/package-lock.json's root version is ${JSON.stringify(lock?.version)} but package.json says ` +
        `${JSON.stringify(manifestVersion)} — run \`npm install --package-lock-only\` to resync the lock.`,
    );
  }
  const lockRootPkg = lock?.packages?.[''];
  if (lockRootPkg?.version !== manifestVersion) {
    problems.push(
      `${cwd}/package-lock.json's packages[""].version is ${JSON.stringify(lockRootPkg?.version)} but ` +
        `package.json says ${JSON.stringify(
          manifestVersion,
        )} — the same \`npm install --package-lock-only\` fixes both fields.`,
    );
  }
  return problems;
}

const readJson = (p) => {
  if (!existsSync(p)) {
    console.error(
      `check-lock-version: ${p} does not exist — the check needs both files in the repo root. ` +
        `A missing lock means nothing pins the tree; run \`npm install --package-lock-only\` to write one.`,
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
};

if (process.argv.includes('--self-test')) {
  // The SUBPROCESS cases: the pure cases below cannot see the main mode's
  // readJson/exit wiring, so a defanged exit code kept them green (the round-1
  // finding). These run the real script over real fixtures and assert the exit
  // code — the guard cannot stop guarding silently, and a missing input file
  // fails loudly too (the branch no pure case can reach).
  {
    let failed = 0;
    const here = dirname(fileURLToPath(import.meta.url));
    const runOver = (name, write) => {
      const dir = mkdtempSync(join(tmpdir(), 'check-lock-version-'));
      let verdict;
      try {
        write(dir);
        const run = spawnSync(process.execPath, [join(here, 'check-lock-version.mjs')], {
          cwd: dir,
          encoding: 'utf8',
        });
        verdict = { status: run.status, stderr: run.stderr };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return { name, ...verdict };
    };
    const subprocessCases = [
      runOver('the real run over a desynced fixture exits 1 with both problems', (dir) => {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
        writeFileSync(
          join(dir, 'package-lock.json'),
          JSON.stringify({ version: '1.9.0', packages: { '': { version: '1.9.0' } } }),
        );
      }),
      runOver('a missing lock file fails with the check message, not a stack', (dir) => {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
      }),
    ];
    const wants = [/root version/, /does not exist/];
    for (let i = 0; i < subprocessCases.length; i++) {
      const c = subprocessCases[i];
      const ok = c.status === 1 && wants[i].test(c.stderr);
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
      if (!ok) {
        console.error(c.stderr);
        failed += 1;
      }
    }
    // Exit AFTER the fixtures are cleaned (the finally above): process.exit
    // inside the loop would skip later cleanups.
    if (failed > 0) process.exit(1);
  }
  const cases = [
    {
      name: 'in sync passes',
      pkg: { version: '1.0.0' },
      lock: { version: '1.0.0', packages: { '': { version: '1.0.0' } } },
      want: 0,
    },
    {
      name: 'a root-only mismatch fails with the fix command',
      pkg: { version: '1.0.1' },
      lock: { version: '1.0.0', packages: { '': { version: '1.0.0' } } },
      want: /package-lock\.json's root version.*npm install --package-lock-only/,
    },
    {
      name: 'a packages[""] mismatch fails too',
      pkg: { version: '1.0.1' },
      lock: { version: '1.0.1', packages: { '': { version: '1.0.0' } } },
      want: /packages\[""\]\.version/,
    },
    {
      name: 'a missing manifest version is its own failure',
      pkg: {},
      lock: { version: '1.0.0' },
      want: /no version field/,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const problems = checkLockVersion({ pkg: c.pkg, lock: c.lock });
    const ok =
      (c.want === 0 && problems.length === 0) || (c.want instanceof RegExp && problems.some((p) => c.want.test(p)));
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
    if (!ok) failed += 1;
  }
  console.log(
    `${failed === 0 ? 'OK' : 'FAILED'}: ${cases.length - failed}/${
      cases.length
    } self-test cases (+ the subprocess cases above).`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const problems = checkLockVersion({ pkg, lock });
for (const p of problems) console.error(`check-lock-version: ${p}`);
if (problems.length > 0) process.exit(1);
console.log(
  `OK: package.json ${pkg.version} = package-lock.json ${lock.version} (root and packages[""]) — manifest and lock agree.`,
);
