import { checkUntested } from '@immediately-run/verify-checks/untested';

// Worker entry files are parcel targets, not logic paths: they are bundles'
// roots, wired by build tooling, and the check reads PRs, not bundles.
await checkUntested({
  base: 'origin/main',
  logicPaths: {
    include: ['src/**'],
    exclude: [
      'src/index.ts',
      'src/services/authoring/authoring-worker.ts',
      'src/services/authoring/worker-lib-host.ts',
      'src/services/authoring/worker-lint-host.ts',
    ],
  },
});
