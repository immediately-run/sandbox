import { checkUntested } from '@immediately-run/verify-checks/untested';

// Worker entry files are parcel targets, not logic paths: they are bundles'
// roots, wired by build tooling, and the check reads PRs, not bundles.
// embeddedToolchainHash.ts is likewise generated on every build (its header says
// so): there is no logic to test, and the committed copy exists only so jest and
// `npm run dev` see it without a build. (Nothing asserts committed == generated —
// main carried a stale hash from the R3-258 bump until R3-814; that gap is filed
// as R3-838, not excused.)
await checkUntested({
  base: 'origin/main',
  logicPaths: {
    include: ['src/**'],
    exclude: [
      'src/index.ts',
      'src/services/authoring/authoring-worker.ts',
      'src/services/authoring/worker-lib-host.ts',
      'src/services/authoring/worker-lint-host.ts',
      'src/bundler/artifacts/embeddedToolchainHash.ts',
    ],
  },
});
