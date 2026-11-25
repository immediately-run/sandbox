// check:untested — coverage mode for src/** (the plan is
// docs/content/plans/untested-coverage in the docs repo).
//
// The name check this replaces asked "does a file with the same stem and a
// .test. extension exist?". Coverage mode asks "are this diff's changed lines
// executed by the test run?", against jest's coverage-final.json.
//
// The coverage pass is the full suite, through `npm test` so the pretest leg
// generates the authoring bundles the suites import. Three cheaper shapes were
// weighed. A related-tests subset (--findRelatedTests) is out: the baseline is
// seeded from a full run, and a line that only an unrelated suite covers would
// read as a new gap. Instrumenting only the changed files (a narrower
// collectCoverageFrom over the same full suite) gives the same answer for
// those files, but saved nothing measurable: on the 8-core dev machine, under
// load from other jobs, full-suite runs took 96-221 s with coverage and
// 123-320 s without, so instrumentation cost is inside the noise and the one
// glob that seeding needs anyway is kept. CI-only instrumentation is out for
// the same reason: there is no local cost to avoid, and local == CI keeps the
// gate honest. A diff that changes no logic file skips the run.
//
// The coverage provider is jest's default (babel/istanbul). The v8 provider
// reports every source line as a statement here, comments included, so every
// changed comment would become a finding.
//
// The logic paths are the TypeScript sources: what jest can instrument.
// collectCoverageFrom lists every non-test TypeScript file under src/, a
// superset of the logic paths, so a logic file that no suite imports is in
// the report with zero hits on its real statements. HTML documents, JSON and
// JavaScript files under src/, and everything under the resolver's fixture
// tree, are not logic paths: no coverage report can speak for them (the
// resolver tests read the fixture files by path and never execute them).
// Declaration files and the two type-only modules are excluded by name below,
// because jest emits no coverage record for a module with no runtime
// statement. A new type-only module is absent from the report the same way.
// The check cannot measure an absent file, so it fails the branch that adds
// one as NEW ("the test run never loads it"); that file needs an `Untested:`
// trailer saying it has no runtime path, or an entry in the exclusions below.
//
// The ratchet is verify-baselines/untested.json: one count per file, the
// number of its executable lines the suite never runs ("unloaded" for a file
// the report has no record of). A changed logic file fails as NEW when its
// count is above the recorded one; an entry is STALE when the count dropped,
// and the message names the number to write. No line number is stored, so an
// edit that changes no coverage changes no verdict. Seed with
// --write-baseline (the file must not exist), and only from a run in which
// every suite passed: a jest worker that crashes can exit 0 and drop its
// suites' coverage, and the seed then records covered lines as gaps.
//
// What the skip costs: a branch that changes only tests has no coverage run,
// so when it closes a recorded gap it is not told to lower the entry. The
// next branch that changes a logic file gets that STALE line instead.
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
  include: ['src/**/*.{ts,tsx}'],
  exclude: [
    'src/index.ts',
    'src/services/authoring/authoring-worker.ts',
    'src/services/authoring/worker-lib-host.ts',
    'src/services/authoring/worker-lint-host.ts',
    'src/bundler/artifacts/embeddedToolchainHash.ts',
    // No runtime statement, so no coverage record (see the header).
    'src/**/*.d.ts',
    'src/types.ts',
    'src/protocol/message-types.ts',
    // Resolver fixtures: read by path, never executed. Two of them are
    // (empty) TypeScript files and would match the include.
    'src/resolver/fixture/**',
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
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
} else {
  // No logic file changed, so no file can be NEW. Over the empty report the
  // check still reports an entry whose file is gone or left the logic paths;
  // it compares no count, because the report has no record of any file.
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, '{}\n');
}

checkUntestedCoverage({
  base: BASE,
  logicPaths: LOGIC_PATHS,
  coverageReportPath: REPORT,
  baselinePath: 'verify-baselines/untested.json',
});
