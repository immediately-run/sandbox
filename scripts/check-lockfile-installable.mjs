#!/usr/bin/env node
// check-lockfile-installable.mjs — R3-477, half 1: the committed package-lock.json
// must be `npm ci`-installable AS COMMITTED.
//
// THE FAILURE THIS EXISTS FOR (2026-08-31, R3-477's reproduction). `npm install`
// — for any reason, including a one-package bump — PRUNES `optional + peer`
// entries under optional subtrees:
//
//     - "node_modules/firebase-tools/node_modules/@types/node":  { version: "26.4.0", … peer, optional }
//     - "node_modules/firebase-tools/node_modules/undici-types": { version: "8.3.0",  … peer, optional }
//
// The committed lockfile is HEALTHY; the damage arrives with the contributor who
// runs the obvious command and commits the churn. The next `npm ci` then finds
// the entries absent, resolves them fresh against the registry, lands on
// whatever is newest, and fails EUSAGE ("Missing: @types/node@26.4.0 from lock
// file") — and until this check, the only protection was a comment beside CI's
// `npm ci` step telling the reader not to follow npm's own advice.
//
// WHY `npm ci --dry-run` IS THE ORACLE. A hand-rolled graph invariant is wrong
// by construction: healthy npm lockfiles legitimately carry unsatisfied OPTIONAL
// peer edges, absent optional dependencies, and alias specs — an earlier draft
// of this check asserted closure over all of them and produced 68 false
// positives on main's own healthy lockfile. npm's resolver is the only authority
// on what a resolvable lockfile is, and `npm ci --dry-run` runs exactly the
// resolution CI's real `npm ci` performs, without touching node_modules. The
// pruned state is the state where that resolution FAILS — the same EUSAGE the
// incident produced.
//
// AN UNREACHABLE REGISTRY IS A THIRD OUTCOME, NOT A PASS — and not always a
// fail either. Locally it prints a loud warning and passes (a dev on a train
// must still be able to run verify); in CI it FAILS (CI's network is part of
// the contract). This mirrors check-dependency-pins.mjs's local/CI split for
// the same reason: iterating locally must stay possible, and "could not tell"
// must never be silently relabelled "fine".
//
//     node scripts/check-lockfile-installable.mjs --self-test   (prove the classifier can fail)
//     node scripts/check-lockfile-installable.mjs               (the check)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Classify one `npm ci --dry-run --ignore-scripts` run. Pure, so the self-test
 * can prove each branch on canned output.
 *   kind 'ok'            — the lockfile resolves as committed
 *   kind 'lockfile'      — npm refuses the lockfile (the R3-477 prune's EUSAGE,
 *                          missing-entry, or manifest↔lockfile disagreement)
 *   kind 'network'       — could not tell: registry unreachable
 */
export function classify(text, code) {
  const t = (text ?? '').toLowerCase();
  if (code === 0) return { kind: 'ok' };
  if (/eusage|missing:|lock file|does not satisfy|npm err! ci can only install/.test(t)) {
    return { kind: 'lockfile' };
  }
  if (/enotfound|etimedout|econnreset|eai_again|network|requestfailed|e404|getaddrinfo/.test(t)) {
    return { kind: 'network' };
  }
  // An unknown non-zero exit is treated as a lockfile problem: the oracle spoke
  // and did not approve, and guessing "network" to soften it is exactly the
  // silent-pass failure this file's siblings warn about.
  return { kind: 'lockfile' };
}

const FIX_GUIDANCE =
  'Do NOT follow npm\'s advice to "update your lock file with npm install" — that is what\n' +
  'CAUSED the R3-477 prune. The repair is ADDITIVE: re-add the exact entry npm names\n' +
  '(version + resolved + integrity, `optional`/`peer` as its siblings have them) to\n' +
  'package-lock.json by hand, leaving every other entry alone, then confirm with a clean\n' +
  '`npm ci`.';

const selfTest = () => {
  let failures = 0;
  let ran = 0;
  const expect = (label, got, kind) => {
    if (got.kind !== kind) {
      console.error(`SELF-TEST FAIL: ${label}\n  got: ${got.kind}, want: ${kind}`);
      failures++;
    } else {
      console.log(`  ok  ${label}`);
    }
    ran++;
  };

  expect('a clean run is ok', classify('added 1530 packages in 2s', 0), 'ok');
  expect(
    'the R3-477 EUSAGE is a lockfile failure',
    classify('npm error code EUSAGE\nnpm error Missing: @types/node@26.4.0 from lock file', 1),
    'lockfile',
  );
  expect(
    'a manifest/lockfile disagreement is a lockfile failure',
    classify(
      "npm error code EUSAGE\nnpm error lock file's @immediately-run/sandbox-protocol@0.3.1 does not satisfy @immediately-run/sandbox-protocol@0.4.0",
      1,
    ),
    'lockfile',
  );
  expect(
    'a registry DNS failure is network',
    classify('npm error code ENOTFOUND\nnpm error network request failed', 1),
    'network',
  );
  expect('a connection reset is network', classify('npm error code ECONNRESET', 1), 'network');
  expect(
    'an unclassified non-zero exit is a lockfile failure, never a soft pass',
    classify('npm error code ELIFECYCLE weird', 1),
    'lockfile',
  );

  // THE REAL PRODUCER, hermetic and offline-safe: a temp dir with a package.json
  // and NO lockfile — `npm ci --dry-run` refuses it with the real EUSAGE, in
  // under a second, touching nothing outside the temp dir. The classifier is
  // asserted on npm's ACTUAL output, not a transcription of it.
  try {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-check-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
    let realOut = '';
    let realCode = 0;
    try {
      realOut = execFileSync('npm', ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'], {
        encoding: 'utf8',
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (e) {
      realCode = e.status ?? 1;
      realOut = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    }
    rmSync(dir, { recursive: true, force: true });
    expect(
      'the classifier on REAL npm output: no lockfile at all is a lockfile failure',
      classify(realOut, realCode),
      'lockfile',
    );
  } catch (fixtureErr) {
    console.error(`SELF-TEST FAIL: could not run the real-producer fixture (${fixtureErr})`);
    failures++;
  }
  ran++;

  if (failures) {
    console.error(`\n${failures} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log(`${ran}/${ran} self-test cases.`);
  process.exit(0);
};

if (process.argv.includes('--self-test')) selfTest();

let out = '';
let code = 0;
try {
  out = execFileSync('npm', ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    // A full resolve is bounded: CI's real `npm ci` completes in ~90 s. On
    // timeout the run is killed and classified could-not-tell (the network
    // branch below): CI red, local warn — the same bound fetchVersions() sets
    // for its npm call.
    timeout: 120_000,
  });
} catch (e) {
  code = e.status ?? 1;
  out = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
}
const verdict = classify(out, code);
if (verdict.kind === 'ok') {
  console.log('OK: package-lock.json is npm ci-installable as committed.');
  process.exit(0);
}
if (verdict.kind === 'network') {
  const note =
    `WARNING: could NOT verify the lockfile is installable — npm could not reach the registry\n` +
    `(this is not a pass). Locally this is tolerated so verify stays runnable offline; CI fails\n` +
    `here. Re-run when the network is up.`;
  if (process.env.CI) {
    console.error(note);
    process.exit(1);
  }
  console.log(note);
  process.exit(0);
}
console.error('\nlockfile-installable check FAILED: the committed package-lock.json does not\nresolve under npm ci.\n');
// The DIAGNOSTIC head, not the blind tail: npm's EUSAGE puts "Missing: <pkg>@<version>
// from lock file" near the top and pads the rest with flags help — a tail slice shows
// the help and hides the entry the repair guidance tells the reader to re-add.
const lines = (out || '').split('\n');
const diagnostic = lines.filter((l) =>
  /npm error|EUSAGE|Missing:|Invalid:|does not satisfy|can only install|usage:|added \d+ packages?/i.test(l),
);
console.error((diagnostic.length ? diagnostic : lines).slice(0, 16).join('\n'));
console.error(`\n${FIX_GUIDANCE}`);
process.exit(1);
