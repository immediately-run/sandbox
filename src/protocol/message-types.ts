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
}

export type BundlerStatus =
  | 'initializing'
  | 'installing-dependencies'
  | 'transpiling'
  | 'evaluating'
  | 'running-tests'
  | 'idle';
