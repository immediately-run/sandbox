import { checkUntested } from '@immediately-run/verify-checks/untested';

// Worker entry files are parcel targets, not logic paths: they are bundles'
// roots, wired by build tooling, and the check reads PRs, not bundles.
// embeddedToolchainHash.ts is likewise generated-on-build (its header says so):
// the generator IS its test surface (the deploy asserts it equals the CLI's stamp).
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
