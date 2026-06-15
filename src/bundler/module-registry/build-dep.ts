// Build-time-only dependency filtering now lives in @immediately-run/transpiler
// (the single source of truth shared with the CLI's lockset derivation,
// PRETRANSPILED_ARTIFACTS_SPEC §4.4). Re-exported here so existing importers keep
// their path.
export { filterBuildDeps, isBuildDep } from '@immediately-run/transpiler';
