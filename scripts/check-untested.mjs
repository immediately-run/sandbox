// check:untested — coverage mode for src/** (the plan is
// docs/content/plans/untested-coverage in the docs repo).
//
// The name check this replaces asked "does a file with the same stem and a
// .test. extension exist?". Coverage mode asks "are this diff's changed lines
// executed by the test run?", against jest's coverage-final.json.
//
// The coverage pass is the full suite, through `npm test` so the pretest leg
// generates the authoring bundles the suites import. A subset run
// (--findRelatedTests) would be faster, but the baseline is seeded from a full
// run, and a line that only an unrelated suite covers would then read as a new
// gap. A diff that changes no logic file skips the run.
//
// The coverage provider is jest's default (babel/istanbul). The v8 provider
// reports every source line as a statement here, comments included, so every
// changed comment would become a finding.
//
// collectCoverageFrom lists every non-test TypeScript file under src/, so a
// file no suite imports is in the report with zero hits on its real
// statements. A logic-path file that is not TypeScript (src/index.html, the
// resolver fixtures) is absent from the report; the check counts every line of
// an absent file as uncovered, so the baseline records such a file whole.
// Adding lines to one needs an `Untested:` trailer, as the name check did.
//
// The ratchet is verify-baselines/untested.json: seeded once with
// --write-baseline, shrunk by hand as gaps close. Seed only from a run in
// which every suite passed: a jest worker that crashes can exit 0 and drop
// its suites' coverage, and the seed then records covered lines as gaps.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkUntestedCoverage, changedSince, IS_TEST_FILE, matchesAny } from '@immediately-run/verify-checks/untested';

const BASE = 'origin/main';
const REPORT = 'coverage/coverage-final.json';

// Worker entry files are parcel targets, not logic paths: they are bundles'
// roots, wired by build tooling, and the check reads PRs, not bundles.
// embeddedToolchainHash.ts is generated on every build (its header says so):
// there is no logic to test, and the committed copy exists only so jest and
// `npm run dev` see it without a build; check:toolchain-hash asserts the
// committed copy equals the generated one.
const LOGIC_PATHS = {
  include: ['src/**'],
  exclude: [
    'src/index.ts',
    'src/services/authoring/authoring-worker.ts',
    'src/services/authoring/worker-lib-host.ts',
    'src/services/authoring/worker-lint-host.ts',
    'src/bundler/artifacts/embeddedToolchainHash.ts',
    // Written by `npm run gen:authoring-bundles` and gitignored, so never in a
    // diff; excluded so that seeding, which globs the disk, skips them too.
    'src/services/authoring/bundled-libs.generated.ts',
    'src/services/authoring/bundled-types.generated.ts',
  ],
};

const seeding = process.argv.includes('--write-baseline');
const changedLogic = changedSince(BASE).filter((file) => !IS_TEST_FILE.test(file) && matchesAny(file, LOGIC_PATHS));

// A report left by an earlier run must never be read as this run's.
rmSync(REPORT, { force: true });

if (seeding || changedLogic.length > 0) {
  // execFileSync throws on a non-zero exit, so a failing suite fails the check
  // before a partial report is read.
  execFileSync(
    'npm',
    [
      'test',
      '--',
      '--forceExit',
      '--coverage',
      '--coverageProvider=babel',
      '--coverageReporters=json',
      '--collectCoverageFrom=src/**/*.{ts,tsx}',
      '--collectCoverageFrom=!src/**/*.test.{ts,tsx}',
      '--collectCoverageFrom=!src/**/*.d.ts',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
} else {
  // No logic file changed, so there are no changed lines to check; the
  // stale-entry pass for deleted files still runs over the empty report.
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, '{}\n');
}

checkUntestedCoverage({
  base: BASE,
  logicPaths: LOGIC_PATHS,
  coverageReportPath: REPORT,
  baselinePath: 'verify-baselines/untested.json',
});
