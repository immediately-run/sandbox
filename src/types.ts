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
   * immediately.run-specific build hints (SDK_PACKAGING_SPEC §10, phase 2).
   * Namespaced so it never collides with standard package.json fields.
   */
  immediatelyRun?: {
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
