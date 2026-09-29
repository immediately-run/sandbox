#!/usr/bin/env node
// check-verify-parity.mjs — R3-814: every leg of the `verify` script either runs in
// this repo's CI or is exempted in the workflow file with a stated reason.
//
// THE FAILURE THIS EXISTS FOR. This repo's ci.yml enumerates gates one `- run:` at a
// time and FIVE of verify's legs appeared nowhere in it (check:lockfile-installable,
// check:clones, check:unused, check:untested, check:dist-documents:selftest) — so a
// sandbox branch could be green on GitHub while `npm run verify` was red on it. The
// SDK instance (R3-779, found in sdk#184's review gate, 2026-09-25) proved the class:
// a leg that exists only in local `verify` is enforcement that has not shipped.
//
// Ported from the SDK's R3-779 gate (scripts/check-verify-parity.mjs, itself ported
// from site-main's R3-641 original — the SDK copy carries the block-scalar walk fix,
// site-main#626, which is why THIS port sources the SDK's and not site-main's). The
// three copies are byte-comparable below this header. If you change the MECHANISM
// here, change it in both siblings too (or the port claim here becomes a lie).
//
// MECHANICS.
//   legs     — every `npm run <name>` in the `verify` script, plus `test` for
//              the bare `npm test`. (`CI=true npm run build` yields `build`
//              through the same `npm run` rule.)
//   covered  — a leg a CI `run:` block actually executes: the block contains
//              `npm run <leg>` (or `npm test`), as a command, not a comment.
//              Comment lines inside run blocks are stripped first, so a step's
//              prose cannot satisfy the gate; `npm run check:unused` does not
//              cover `check:unused-something` (boundary-checked).
//   exempt   — a line in the workflow file of the form
//                  # verify-parity-exempt: <leg> — <reason>
//              A declared exemption is a decision on the record; an absent one
//              is a gap. An exemption naming a leg `verify` no longer has is
//              stale and fails the same way — delete the line.
//
//   scope    — "covered" means a `run:` block ANYWHERE in the workflow file,
//              including push-only jobs: the gate asserts a leg RUNS in CI, not
//              that it gates PRs. Every current leg maps to the PR-triggered
//              job (verified 2026-09-29); a leg moving to a push-only job is
//              the known hole, named here rather than scanned for.
//
//     node scripts/check-verify-parity.mjs --self-test   (prove the classifier can fail)
//     node scripts/check-verify-parity.mjs               (the check)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_PATH = 'package.json';
const WORKFLOW_PATH = '.github/workflows/ci.yml';

// The legs of the `verify` script: every `npm run <name>`, plus `test` when the
// script invokes the test runner as the bare `npm test`.
export function parseVerifyLegs(verifyScript) {
  const legs = new Set();
  for (const m of verifyScript.matchAll(/npm run ([^\s&|;]+)/g)) legs.add(m[1]);
  if (/\bnpm test\b/.test(verifyScript)) legs.add('test');
  return [...legs].sort();
}

// The commands CI executes: every `run:` block's content, comments stripped.
// Handles inline scalars (`run: npm foo`) and block scalars (`run: |` / `>-`
// with indented continuation lines); anything more exotic than that does not
// appear in this file, and an unparsed line errs toward "not covered", which
// is the loud direction.
export function parseCiRunBlocks(ciText) {
  const lines = ciText.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const [, indent, rest] = m;
    const stripped = rest.trim();
    if (stripped && !/^[|>][|>?+\-]*$/.test(stripped)) {
      // A comment-only inline scalar (`run: # note`) carries no command.
      if (!stripped.startsWith('#')) blocks.push(stripComment(stripped));
      continue;
    }
    const keyIndent = indent.length;
    const body = [];
    // A separate index for the block walk: the line that ENDS the block (indent
    // no longer deeper) is a line the OUTER loop must still read — reusing `i`
    // and letting the outer `i++` advance past it skips a `run:` that follows a
    // block scalar directly (fired the moment a `run: |` step group was
    // followed by `- run: npm test` and the `test` leg falsely read uncovered;
    // site-main#626 / sdk#189, R3-779). Fail-LOUD, but a false red on an
    // innocent PR is still a bug.
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent <= keyIndent) break;
      // Full-line comments inside the block are dropped BEFORE trimming, so a
      // `# …` line can never contribute (or be read as) a command.
      if (line.trim().startsWith('#')) continue;
      body.push(stripComment(line.trim()));
    }
    i = j - 1;
    if (body.length) blocks.push(body.join('\n'));
  }
  return blocks;
}

function stripComment(line) {
  // Commands here never carry a literal `#` (no colour codes, no sed scripts);
  // a ` #` starts a comment.
  return line.replace(/\s+#.*$/, '');
}

// Exemption comments anywhere in the file: `# verify-parity-exempt: <leg> — <reason>`
// (the separator is an em dash; `:` cannot be one, it appears inside leg names).
// A missing or empty reason is not an exemption.
export function parseExemptions(ciText) {
  const exemptions = new Map();
  for (const m of ciText.matchAll(/^\s*#\s*verify-parity-exempt:\s*([\w.:-]+)\s*—\s*(.+?)\s*$/gm)) {
    exemptions.set(m[1], m[2]);
  }
  return exemptions;
}

// A leg is covered when a block RUNS it, in command position — the start of a
// block or right after a command separator, with only `VAR=value` environment
// prefixes allowed between (an env-prefixed `CI=true npm run build` RUNS the
// leg) — never merely NAMED (an echo'd error message quoting `npm run <leg>` is
// prose about the command, not an execution of it). The leg name is
// regex-escaped before interpolation: a future leg name carrying a
// metacharacter must not read a different command as coverage — the silent
// direction this gate exists to catch.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMAND_HEAD = '(?:^|[\\n;&|]\\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*';
function legCoveredIn(block, leg) {
  const pattern =
    leg === 'test'
      ? new RegExp(`${COMMAND_HEAD}npm test\\b(?![-\\w])`)
      : new RegExp(`${COMMAND_HEAD}npm run ${escapeRe(leg)}(?![-\\w:])`);
  return pattern.test(block);
}

// The verdict: legs with neither CI coverage nor an exemption, and exemptions
// whose leg `verify` no longer carries.
export function auditVerifyParity(verifyScript, ciText) {
  const legs = parseVerifyLegs(verifyScript);
  const blocks = parseCiRunBlocks(ciText);
  const exemptions = parseExemptions(ciText);
  const uncovered = legs.filter((leg) => !blocks.some((b) => legCoveredIn(b, leg)));
  const missing = uncovered.filter((leg) => !exemptions.has(leg));
  const stale = [...exemptions.keys()].filter((leg) => !legs.includes(leg));
  return { legs, missing, stale, exemptions };
}

function selfTest() {
  const cases = [
    {
      name: 'a leg covered by a run block passes',
      verify: 'npm run check:a && npm test',
      ci: 'steps:\n  - run: npm run check:a\n  - run: npm test -- --ci\n',
      expect: 'ok',
    },
    {
      name: 'a leg with no CI step fails',
      verify: 'npm run check:a && npm run check:b',
      ci: 'steps:\n  - run: npm run check:a\n',
      expect: 'fail',
    },
    {
      name: 'a leg named only in a run-block comment does NOT count as covered',
      verify: 'npm run check:a && npm run check:b',
      ci: 'steps:\n  - run: npm run check:a # also consider npm run check:b\n',
      expect: 'fail',
    },
    {
      name: 'a leg named only in a prose comment does NOT count as covered',
      verify: 'npm run check:a && npm run check:b',
      ci: '# npm run check:b is nice\nsteps:\n  - run: npm run check:a\n',
      expect: 'fail',
    },
    {
      name: 'a leg named only in a comment INSIDE a run block does NOT count as covered',
      verify: 'npm run check:a && npm run check:b',
      ci: 'steps:\n  - run: |\n      # TODO: also run npm run check:b\n      npm run check:a\n',
      expect: 'fail',
    },
    {
      name: 'a comment-only inline run carries no command',
      verify: 'npm run check:a && npm run check:b',
      ci: 'steps:\n  - run: # npm run check:b lives elsewhere\n  - run: npm run check:a\n',
      expect: 'fail',
    },
    {
      name: 'a declared exemption with a reason passes',
      verify: 'npm run check:a && npm run check:b',
      ci: 'steps:\n  - run: npm run check:a\n# verify-parity-exempt: check:b — runs only in the deploy workflow\n',
      expect: 'ok',
    },
    {
      name: 'an exemption with no reason is not an exemption',
      verify: 'npm run check:a && npm run check:b',
      ci: 'steps:\n  - run: npm run check:a\n# verify-parity-exempt: check:b\n',
      expect: 'fail',
    },
    {
      name: 'an exemption whose leg verify no longer has is stale and fails',
      verify: 'npm run check:a',
      ci: 'steps:\n  - run: npm run check:a\n# verify-parity-exempt: check:gone — retired\n',
      expect: 'fail',
    },
    {
      name: 'boundary: check:ab does not cover check:a',
      verify: 'npm run check:a',
      ci: 'steps:\n  - run: npm run check:ab\n',
      expect: 'fail',
    },
    {
      name: 'block scalars are read as commands',
      verify: 'npm run check:a && npm test',
      ci: 'steps:\n  - run: |\n      npm run check:a\n      npm test -- --ci --forceExit\n',
      expect: 'ok',
    },
    {
      name: 'a run line immediately AFTER a block scalar is still read (the block walk must not consume it)',
      verify: 'npm run check:a && npm test',
      ci: 'steps:\n  - run: |\n      npm run check:a\n  - run: npm test\n',
      expect: 'ok',
    },
    {
      name: "a leg named inside a QUOTED STRING (an echo'd error message) is not coverage",
      verify: 'npm run check:a && npm run check:b',
      ci: 'steps:\n  - run: npm run check:a\n  - run: echo "::error::add npm run check:b to ci.yml"\n',
      expect: 'fail',
    },
    {
      name: 'an env-prefix still counts as command position (CI=true npm run <leg> RUNS the leg)',
      verify: 'npm run check:a',
      ci: 'steps:\n  - run: CI=true npm run check:a\n',
      expect: 'ok',
    },
  ];
  // The anchoring case: the parser against the REAL package.json and ci.yml —
  // a fixture-only suite proves the classifier logic and nothing about the
  // producer it parses (the check-docs-wiki lesson: self-tests that hand-type
  // both inputs pass while the real file drifts past the grammar).
  const realVerify = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).scripts.verify;
  const realLegs = parseVerifyLegs(realVerify);
  const anchored = realLegs.length >= 10 && realLegs.includes('test');
  if (!anchored) {
    console.error(
      `  ✗ self-test: the REAL verify script parsed to ${realLegs.length} legs — parser broke against its producer`,
    );
    process.exit(1);
  }
  console.log(`  ✓ self-test: the real verify script parses to ${realLegs.length} legs (anchored to the producer)`);

  let failed = 0;
  for (const c of cases) {
    const { missing, stale } = auditVerifyParity(c.verify, c.ci);
    const clean = missing.length === 0 && stale.length === 0;
    const pass = c.expect === 'ok' ? clean : !clean;
    if (!pass) {
      failed++;
      console.error(`  ✗ self-test: ${c.name} (missing=[${missing}] stale=[${stale}])`);
    }
  }
  if (failed) {
    console.error(`check-verify-parity: --self-test failed ${failed}/${cases.length} cases`);
    process.exit(1);
  }
  console.log(`check-verify-parity: --self-test green (${cases.length}/${cases.length} cases)`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const { verify: verifyScript } = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).scripts;
  const ciText = readFileSync(WORKFLOW_PATH, 'utf8');
  const { legs, missing, stale, exemptions } = auditVerifyParity(verifyScript, ciText);
  // A zero-leg parse is a BROKEN parser, not parity achieved — otherwise the
  // gate vacuously passes on the day the verify script changes shape, which is
  // one level up the exact blind spot this check exists to close.
  if (legs.length === 0) {
    console.error('✗ verify-parity: the verify script parsed to ZERO legs — the parser broke, not parity achieved');
    process.exit(1);
  }
  if (stale.length) {
    for (const leg of stale) {
      console.error(`✗ verify-parity: exempt leg "${leg}" is not in the verify script — delete the exemption line`);
    }
  }
  if (missing.length) {
    for (const leg of missing) {
      console.error(
        `✗ verify-parity: verify leg "${leg}" has no CI step and no exemption —` +
          ` add it to .github/workflows/ci.yml or record` +
          ` "# verify-parity-exempt: ${leg} — <reason>" there`,
      );
    }
    process.exit(1);
  }
  if (stale.length) process.exit(1);
  console.log(
    `check-verify-parity: all ${legs.length} verify legs run in CI or are exempted` +
      (exemptions.size ? ` (${[...exemptions.keys()].join(', ')} exempted)` : ''),
  );
}

// Run only as a script — the parsers stay importable for tests without an
// import executing the audit (and its process.exit) inside the importer.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
