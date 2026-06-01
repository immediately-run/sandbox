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
}

export type BundlerStatus =
  | 'initializing'
  | 'installing-dependencies'
  | 'transpiling'
  | 'evaluating'
  | 'running-tests'
  | 'idle';
