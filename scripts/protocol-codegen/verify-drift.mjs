#!/usr/bin/env node
/*
 * Are the four SHIPPED projections still exactly what the descriptors produce?
 *
 * `src/generated/protocol.ts` and `protocol-snapshot.json` say DO NOT EDIT, which
 * is a request, not a mechanism. This is the mechanism: regenerate into a scratch
 * directory and compare bytes. It catches all three ways the single-source property
 * breaks —
 *   1. someone hand-edits a generated file;
 *   2. someone edits the descriptors and forgets to regenerate + commit;
 *   3. the generator changes and the committed output goes stale.
 *
 * It also runs the descriptor round-trip (`transcribe.mjs --check`): the snapshots
 * project back to exactly the committed descriptors. Generation and transcription
 * are inverses, so a lossy step in either direction fails here rather than being
 * discovered by whoever next tries to change a wire name.
 *
 * Run: node scripts/protocol-codegen/verify-drift.mjs [--self-test]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** The generator's four outputs, relative to the repo root. */
const OUTPUTS = [
  'src/generated/protocol.ts',
  'protocol-snapshot.json',
  'generated/sdk/protocol.ts',
  'generated/sdk/protocol-snapshot.json',
];

for (const rel of OUTPUTS) {
  if (!existsSync(join(root, rel))) {
    console.error(`error: ${rel} missing — run \`npm run protocol:generate\`.`);
    process.exit(1);
  }
}

/** Regenerate into a scratch tree; returns { rel: text }. */
const regenerate = () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ir-protocol-'));
  try {
    cpSync(here, join(tmp, 'scripts', 'protocol-codegen'), { recursive: true });
    execFileSync(process.execPath, [join(tmp, 'scripts/protocol-codegen/generate.mjs'), '--out', tmp], {
      cwd: tmp,
      stdio: 'pipe',
    });
    return Object.fromEntries(OUTPUTS.map((rel) => [rel, readFileSync(join(tmp, rel), 'utf8')]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

/** @returns the first drifting output, or null. */
const check = (shipped) => {
  const fresh = regenerate();
  for (const rel of OUTPUTS) {
    if (fresh[rel] === shipped[rel]) continue;
    const a = (shipped[rel] ?? '').split('\n');
    const b = fresh[rel].split('\n');
    const i = a.findIndex((l, n) => l !== b[n]);
    return { rel, line: i + 1, shipped: a[i] ?? '(end of file)', fresh: b[i] ?? '(end of file)' };
  }
  return null;
};

const readShipped = () =>
  Object.fromEntries(OUTPUTS.map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));

const roundTrip = () => {
  try {
    execFileSync(process.execPath, [join(here, 'transcribe.mjs'), '--check'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const main = () => {
  const drift = check(readShipped());
  if (drift) {
    console.log(`FAIL  ${drift.rel} differs from a fresh generation.`);
    console.log(`   first difference at line ${drift.line}`);
    console.log(`     committed: ${drift.shipped}`);
    console.log(`     generated: ${drift.fresh}`);
    console.error(
      '\nThese files are GENERATED from scripts/protocol-codegen/descriptors.protocol.mjs.\n' +
        'Either one was hand-edited (edit the descriptors instead) or a descriptor change\n' +
        'was not regenerated. Fix with: npm run protocol:generate',
    );
    process.exit(1);
  }
  console.log(`PASS  all ${OUTPUTS.length} projections are exactly what the descriptors produce.`);

  if (!roundTrip()) {
    console.error('FAIL  the snapshots do not transcribe back to the committed descriptors.');
    console.error(
      '\nGeneration and transcription must be inverses — otherwise the descriptors are\n' +
        'no longer the single source, they are a second copy that happens to agree today.',
    );
    process.exit(1);
  }
  console.log('PASS  the snapshots transcribe back to exactly the committed descriptors.');
};

// ── --self-test: the same discipline as the SDK's codegen-parity gates ────────
const selfTest = () => {
  const real = readShipped();
  const cases = [
    [
      'a hand-edited constant in the frame module',
      { ...real, 'src/generated/protocol.ts': real['src/generated/protocol.ts'].replace("export const THEME = 'theme';", "export const THEME = 'host-theme';") },
    ],
    [
      'a hand-edited wire name in the snapshot',
      { ...real, 'protocol-snapshot.json': real['protocol-snapshot.json'].replace('"mount-add"', '"mount-added"') },
    ],
    [
      'a hand-edited SDK-side module',
      { ...real, 'generated/sdk/protocol.ts': real['generated/sdk/protocol.ts'] + '\nexport const sneaked = 1;\n' },
    ],
    [
      'a hand-edited SDK-side snapshot',
      { ...real, 'generated/sdk/protocol-snapshot.json': real['generated/sdk/protocol-snapshot.json'].replace('"optional": false', '"optional": true') },
    ],
    [
      'a deleted line',
      { ...real, 'src/generated/protocol.ts': real['src/generated/protocol.ts'].split('\n').filter((_, i) => i !== 20).join('\n') },
    ],
  ];

  let ok = 0;
  for (const [label, poisoned] of cases) {
    for (const rel of OUTPUTS) {
      if (poisoned[rel] !== real[rel]) break;
      if (rel === OUTPUTS[OUTPUTS.length - 1]) {
        console.error(`FAIL  self-test case "${label}" no longer changes any output`);
        process.exit(1);
      }
    }
    const caught = check(poisoned) !== null;
    console.log(`${caught ? 'PASS' : 'FAIL'}  detects: ${label}`);
    if (caught) ok++;
  }

  const cleanOk = check(real) === null;
  console.log(`${cleanOk ? 'PASS' : 'FAIL'}  the committed projections are clean (no false positive)`);
  if (cleanOk) ok++;

  const rtOk = roundTrip();
  console.log(`${rtOk ? 'PASS' : 'FAIL'}  snapshots → descriptors round-trips`);
  if (rtOk) ok++;

  const total = cases.length + 2;
  console.log(`\n${ok}/${total} self-test cases.`);
  if (ok !== total) {
    console.error('\nself-test FAILED — the drift gate is not detecting drift it must detect.');
    process.exit(1);
  }
};

if (process.argv.includes('--self-test')) selfTest();
else main();
