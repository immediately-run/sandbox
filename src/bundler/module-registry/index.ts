import { assertDependenciesResolved, transformFile } from '@immediately-run/transpiler';

import * as logger from '../../utils/logger';
import { sortObj } from '../../utils/object';
import { Bundler } from '../bundler';
import { Module } from '../module/Module';
import { filterBuildDeps } from './build-dep';
import { depMapsEqual, locksetClosureValid, LocksetSection } from './lockset';
import { ICDNModule, ICDNModuleFile, IResolvedDependency, fetchManifest, fetchModule } from './module-cdn';
import {
  bundledIndexPath,
  bundledPackagePath,
  decodeBundledModule,
  parseBundledIndex,
} from './bundledPackages';
import {
  EsmFallbackFetcher,
  esmFallbackEntryUrl,
  esmFallbackModulePath,
  fetchEsmFallbackSource,
  nativeEsmFallbackFetcher,
  synthesizeEsmFallbackModule,
} from './esm-fallback';
import { NodeModule } from './NodeModule';

// dependency => version range
export type DepMap = { [depName: string]: string };

// The resolution-completeness guard (`assertDependenciesResolved`) lives in
// @immediately-run/transpiler alongside `computeInputDepMap`, the single source
// of truth shared with the CLI cache-zip builder (PRETRANSPILED_ARTIFACTS_SPEC
// §4.4) so a silently-dropped package reads identically at boot and at build time.

export class ModuleRegistry {
  modules: Map<string, NodeModule> = new Map();
  moduleDownloadPromises: Map<string, Promise<NodeModule>> = new Map();

  manifest: IResolvedDependency[] = [];

  // Bundled-package index (R3-49a): `name@version` → in-zip filename. `undefined`
  // = not yet loaded; `null` = no bundle present / malformed (resolve live).
  private bundledIndex: Map<string, string> | null | undefined = undefined;

  // Packages the primary CDN dropped that we route through the esm.sh fallback
  // (name → requested range). Consulted in `_fetchModule` to synthesize the
  // bridge package instead of fetching from the primary CDN.
  private esmFallbacks: Map<string, string> = new Map();

  bundler: Bundler;

  // esm.sh fallback for primary-CDN-dropped packages, ENABLED by default. It
  // fetches the package's esm.sh source with the resolved deps externalized and
  // transpiles it through the bundler's own chain, so its `require("react")`
  // binds to the APP's React — sharing the one instance (see esm-fallback.ts).
  // This fixes the dual-React render crash the earlier native-import approach hit
  // (lucide-react@1.x icons read `IconContext` via `useContext`). Only fires when
  // the primary CDN actually drops a package; on failure (esm.sh down, a
  // multi-chunk package) it throws the clear `assertDependenciesResolved`-style
  // error. Pass `null` to disable, or a stub fetcher in tests.
  constructor(
    bundler: Bundler,
    private esmFallbackFetcher: EsmFallbackFetcher | null = nativeEsmFallbackFetcher,
  ) {
    this.bundler = bundler;
  }

  // Load the bundled-package index once from the mounted zip. Never throws: a
  // missing/unreadable/malformed index just means "no bundled packages" and every
  // dependency resolves live from the CDN exactly as before.
  private async ensureBundledIndex(): Promise<Map<string, string> | null> {
    if (this.bundledIndex !== undefined) return this.bundledIndex;
    try {
      this.bundledIndex = parseBundledIndex(await this.bundler.fs.readFileAsync(bundledIndexPath()));
    } catch {
      this.bundledIndex = null;
    }
    return this.bundledIndex;
  }

  // Return the bundled `ICDNModule` for a package if one is present in the zip,
  // else null (→ live CDN fetch). A read/decode failure falls back to the CDN too,
  // so a corrupt bundle degrades to the old path rather than breaking the boot.
  private async _fetchBundledModule(name: string, version: string): Promise<ICDNModule | null> {
    const relPath = (await this.ensureBundledIndex())?.get(`${name}@${version}`);
    if (!relPath) return null;
    try {
      const module = decodeBundledModule(await this.bundler.fs.readBytesAsync(bundledPackagePath(relPath)));
      logger.debug('using bundled package (R3-49a), skipping CDN fetch', name, version);
      return module;
    } catch (err) {
      logger.warn('bundled package read failed; falling back to CDN', name, version, err);
      return null;
    }
  }

  async fetchManifest(deps: DepMap, shouldFilterBuildDeps = true, lockset?: LocksetSection): Promise<void> {
    if (shouldFilterBuildDeps) {
      deps = filterBuildDeps(deps);
    }

    const sortedDeps = sortObj(deps);

    // A sidecar lockset (PRETRANSPILED_ARTIFACTS_SPEC §5.4) replaces the
    // blocking /dep_tree request — but only on an exact input match, so a
    // stale or foreign lockset can never be applied. `validateLockset` has
    // already checked shape + cdnVersion; the dependency echo is checked here
    // because this is where the final (filtered) input DepMap exists.
    let resolvedFromLockset = false;
    if (lockset) {
      if (depMapsEqual(sortedDeps, lockset.dependencies)) {
        // The echo matches the INPUT, but a lockset could still inject extra
        // packages into `resolved` (SPEC_REVIEW PT-2). Reject the WHOLE lockset
        // if its resolved set isn't closed over the declared deps; never trust
        // it partially. Falls through to live /dep_tree resolution.
        if (locksetClosureValid(lockset)) {
          logger.debug('Using sidecar lockset, skipping dep_tree resolution', lockset.resolved);
          this.manifest = lockset.resolved;
          resolvedFromLockset = true;
        } else {
          logger.warn('Sidecar lockset failed closure validation (resolved not closed over declared deps); resolving live');
        }
      } else {
        logger.debug('Sidecar lockset dependency echo does not match; resolving live', {
          computed: sortedDeps,
          lockset: lockset.dependencies,
        });
      }
    }

    if (!resolvedFromLockset) {
      logger.debug('Fetching manifest', sortedDeps);
      this.manifest = await fetchManifest(sortedDeps);
      logger.debug('fetched manifest', this.manifest);
    }

    // Completeness applies to BOTH paths. A package the primary CDN drops is
    // missing whether resolved live OR baked into a sidecar lockset — the CLI
    // builds the lockset against the SAME CDN (PRETRANSPILED_ARTIFACTS_SPEC
    // §5.4), so a build-time drop is frozen into `lockset.resolved` and
    // `locksetClosureValid` (which only rejects INJECTED top-level packages, not
    // MISSING ones) won't catch it. Register esm.sh fallbacks (no-op when
    // disabled) then guard, so a dropped dep surfaces the clear error rather than
    // a cryptic undefined import — on either path.
    this.registerEsmFallbacks(sortedDeps);
    assertDependenciesResolved(sortedDeps, this.manifest);
  }

  // For every requested top-level dep the primary CDN silently dropped, register
  // an esm.sh fallback and append a manifest entry so `preloadModules` fetches
  // it. No-op when the fallback is disabled (`esmFallbackLoader === null`).
  private registerEsmFallbacks(requested: DepMap): void {
    if (!this.esmFallbackFetcher) return;
    const resolved = new Set(this.manifest.map((dep) => dep.n));
    for (const [name, range] of Object.entries(requested)) {
      if (resolved.has(name)) continue;
      this.esmFallbacks.set(name, range);
      this.manifest.push({ n: name, v: range, d: 0 });
      logger.warn(`Primary CDN did not resolve "${name}@${range}"; routing through the esm.sh fallback`);
    }
  }

  async preloadModules(): Promise<void> {
    await Promise.all(
      this.manifest.map((dep) => {
        return this.fetchNodeModule(dep.n, dep.v);
      })
    );
  }

  private async _fetchModule(name: string, version: string): Promise<NodeModule> {
    const fallbackRange = this.esmFallbacks.get(name);
    if (fallbackRange !== undefined) {
      return this._fetchEsmFallbackModule(name, fallbackRange);
    }
    // Prefer the zip-bundled content (R3-49a); fall back to the live CDN fetch.
    const module = (await this._fetchBundledModule(name, version)) ?? (await fetchModule(name, version));
    const processedNodeModule = new NodeModule(name, version, module.f, module.m);
    this.modules.set(name, processedNodeModule);
    logger.debug('fetched module', name, version, module);
    return processedNodeModule;
  }

  // Load a primary-CDN-dropped package from esm.sh as a native ES module, stash
  // its namespace on the global for the shim to read, and register a synthetic
  // bridge package (see esm-fallback.ts). A loader failure (404, CSP block,
  // offline) surfaces as a clear error naming the package — never a silent
  // undefined import.
  private async _fetchEsmFallbackModule(name: string, range: string): Promise<NodeModule> {
    // Externalize every already-resolved dep (excluding this package) so esm.sh
    // emits bare imports the bundler resolves to the SHARED instances (esp.
    // react/react-dom) instead of bundling duplicates — see esm-fallback.ts.
    const externals = [...new Set(this.manifest.map((d) => d.n))].filter((n) => n !== name);
    const entryUrl = esmFallbackEntryUrl(name, range, externals);

    let source: string;
    try {
      source = await fetchEsmFallbackSource(entryUrl, this.esmFallbackFetcher!);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not resolve "${name}@${range}" from the package CDN, and the esm.sh fallback (${entryUrl}) also failed: ${reason}`,
      );
    }

    // Transpile the esm.sh ES module through the SAME chain the bundler runs, so
    // its `require("react")` binds to the app's React, not a second instance.
    const transformed = await transformFile({ path: esmFallbackModulePath(name), code: source });
    if ('error' in transformed) {
      throw new Error(
        `Could not use the esm.sh fallback for "${name}@${range}": transpile failed: ${transformed.error.message}`,
      );
    }

    const module = synthesizeEsmFallbackModule(name, range, transformed.code, transformed.deps);
    const processedNodeModule = new NodeModule(name, range, module.f, module.m);
    this.modules.set(name, processedNodeModule);
    logger.debug('resolved module via esm.sh fallback (shared-React transpile)', name, range, entryUrl);
    return processedNodeModule;
  }

  async fetchNodeModule(name: string, version: string): Promise<NodeModule> {
    // Module already found, skip fetching
    // This could also check version, but for now this is fine
    // as we don't allow multiple versions of the same module right now
    const foundModule = this.modules.get(name);
    if (foundModule) {
      return foundModule;
    }

    const cacheKey = `${name}::${version}`;
    let promise = this.moduleDownloadPromises.get(cacheKey);
    if (!promise) {
      promise = this._fetchModule(name, version).finally(() => this.moduleDownloadPromises.delete(cacheKey));
      this.moduleDownloadPromises.set(cacheKey, promise);
    }
    return promise;
  }

  private _writePrecompiledModule(path: string, file: ICDNModuleFile): Array<() => Promise<void>> {
    if (this.bundler.modules.has(path)) {
      return [];
    }

    const module = new Module(path, file.c, true, this.bundler);
    this.bundler.modules.set(path, module);
    return file.d.map((dep) => {
      return async () => {
        await module.addDependency(dep);
        // Transform ONLY the dependency just added (its resolved path), not the whole
        // (growing) dependency set on every add — the latter is ~O(deps²) per module
        // (177k calls vs 3k for a real closure, measured). Each dep is still transformed
        // exactly once across the callbacks; transformModule is idempotent (precompiled
        // modules short-circuit on `compiled != null`).
        const resolved = module.dependencyMap.get(dep);
        if (resolved) {
          this.bundler.transformModule(resolved);
        }
      };
    });
  }

  async loadModuleDependencies() {
    const depPromises = [];
    for (let [moduleName, nodeModule] of this.modules) {
      for (let [fileName, file] of Object.entries(nodeModule.files)) {
        if (typeof file === 'object') {
          const promises = this._writePrecompiledModule(`/node_modules/${moduleName}/${fileName}`, file);
          depPromises.push(...promises);
        }
      }
    }
    await Promise.all(depPromises.map((fn) => fn()));
  }
}
