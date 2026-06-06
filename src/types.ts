import { DepMap } from './bundler/module-registry';

export interface ISandboxFile {
  path: string;
  code: string;
}

export interface IPackageJSON {
  main?: string;
  module?: string;
  source?: string;
  dependencies?: DepMap;
  /**
   * The per-repo `immediately.run` config object (same key the host reads for
   * `requireLatest`/`provides`, see immediatelyRunConfig.ts). The bundler only
   * consumes `resolveFromRegistry` (SDK_PACKAGING_SPEC §10, phase 2).
   */
  'immediately.run'?: {
    /**
     * Names of otherwise-vendored local modules (see `LOCAL_MODULES`) that this
     * app wants resolved from the CDN registry at its *pinned* version instead
     * of receiving the injected singleton. Opt-in per app: the dual-mode signal
     * that makes per-app SDK versions real. Only safe for an SDK that carries
     * the §4 transport fallback (`@immediately-run/sdk` >= 0.2.7), since a
     * CDN-resolved module has no injected `bundler.messageBus`.
     */
    resolveFromRegistry?: string[];
  };
}
