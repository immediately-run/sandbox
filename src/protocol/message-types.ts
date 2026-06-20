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
  // The parent's §5.7 distrust mark for this (repo coordinates, commitSha): when
  // true, the bundler treats the zip's artifact section as absent (seeds nothing,
  // live-transpiles everything). Set by the parent from its persisted store after a
  // prior spot-verify mismatch; cleared by a new commit.
  distrustArtifacts?: boolean;
  // R3-49b ZenFS batch hydration: a bulk snapshot of the mounted tree (`/app` source
  // + bundled `/node_modules` packages) the host serializes at mount. Applied via
  // `CachedFS.hydrate` before the first compile so the bundler reads from memory
  // instead of one Port round-trip per file (`loadNodeModules` — ~99% of cold boot).
  // Optional — absent until the host wires delivery; reads then cross the Port as
  // before. `content` is text for source, bytes for the package msgpack.
  fsSnapshot?: Array<{ path: string; content: string | Uint8Array }>;
  // The chrome region this app instance occupies, e.g. `"panel.agent"` or
  // `"stage.conversation"` (R3-114). Descriptive only — a non-secret string the
  // host already holds; it grants and gates nothing. Surfaced to the app on the
  // `__immediatelyRun__` runtime global so one repo mounted in two regions can
  // render the slots differently (read via the SDK's `getRegion()`/`useRegion()`).
  // Absent for standalone apps / older hosts that don't report it.
  region?: string;
}

export type BundlerStatus =
  | 'initializing'
  | 'installing-dependencies'
  | 'transpiling'
  | 'evaluating'
  | 'running-tests'
  | 'idle';
