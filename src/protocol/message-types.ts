import { SandpackLogLevel } from '../utils/logger';

/**
 * Bootstrap configuration delivered once via the `register-frame` handshake
 * (alongside the transferred fs `MessagePort`). The bundler self-triggers its
 * initial build and rebuilds when the parent relays an `fs-change`, so it no
 * longer receives a per-change `compile` message — these are the only two
 * values it still needs from the parent.
 */
export interface IInitConfig {
  template: string;
  logLevel?: SandpackLogLevel;
  // Host-pinned SDK integrity hashes (SDK_PACKAGING_SPEC §5.2): keyed module →
  // version → { fileRel: 'sha384-<b64>' }. Delivered on register-frame so the
  // bundler can verify self-hosted SDK bytes before evaluation. Optional — when
  // absent, verification is skipped (the host has not wired delivery yet).
  sdkIntegrity?: Record<string, Record<string, Record<string, string>>>;
  // The dirty set (PRETRANSPILED_ARTIFACTS_SPEC §5.2): repo-relative paths that
  // live in the COW writable layer (files edited in a previous session) plus the
  // journal's deleted set. The seeding path never seeds a pre-transpiled artifact
  // for a dirty path — its `/app` content no longer matches the zip the artifact
  // was built from. Optional — absent until the host wires delivery; absence
  // means "nothing dirty" (every artifact eligible, subject to the other checks).
  dirtyPaths?: string[];
}

export type BundlerStatus =
  | 'initializing'
  | 'installing-dependencies'
  | 'transpiling'
  | 'evaluating'
  | 'running-tests'
  | 'idle';
