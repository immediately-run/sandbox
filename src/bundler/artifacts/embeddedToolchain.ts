import { TRANSPILER_VERSION } from '@immediately-run/transpiler';

import type { EmbeddedToolchainIdentity } from './artifactIndex';
import { EMBEDDED_TOOLCHAIN_HASH } from './embeddedToolchainHash';

/**
 * This runtime's own transpiler identity (PRETRANSPILED_ARTIFACTS_SPEC §4.4): the
 * `@immediately-run/transpiler` package version it links + the toolchainHash of
 * that installed package. Pre-transpiled artifacts are consumed only if BOTH match
 * the artifact index's `toolchain` stamp (§5.1); either mismatch ignores all
 * artifacts and the app boots via live transpile.
 */
export function getEmbeddedToolchain(): EmbeddedToolchainIdentity {
  return { version: TRANSPILER_VERSION, toolchainHash: EMBEDDED_TOOLCHAIN_HASH };
}
