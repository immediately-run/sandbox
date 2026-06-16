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
import { NodeModule } from './NodeModule';

// dependency => version range
export type DepMap = { [depName: string]: string };

export class ModuleRegistry {
  modules: Map<string, NodeModule> = new Map();
  moduleDownloadPromises: Map<string, Promise<NodeModule>> = new Map();

  manifest: IResolvedDependency[] = [];

  // Bundled-package index (R3-49a): `name@version` → in-zip filename. `undefined`
  // = not yet loaded; `null` = no bundle present / malformed (resolve live).
  private bundledIndex: Map<string, string> | null | undefined = undefined;

  bundler: Bundler;

  constructor(bundler: Bundler) {
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
    if (lockset) {
      if (depMapsEqual(sortedDeps, lockset.dependencies)) {
        // The echo matches the INPUT, but a lockset could still inject extra
        // packages into `resolved` (SPEC_REVIEW PT-2). Reject the WHOLE lockset
        // if its resolved set isn't closed over the declared deps; never trust
        // it partially. Falls through to live /dep_tree resolution.
        if (locksetClosureValid(lockset)) {
          logger.debug('Using sidecar lockset, skipping dep_tree resolution', lockset.resolved);
          this.manifest = lockset.resolved;
          return;
        }
        logger.warn('Sidecar lockset failed closure validation (resolved not closed over declared deps); resolving live');
      } else {
        logger.debug('Sidecar lockset dependency echo does not match; resolving live', {
          computed: sortedDeps,
          lockset: lockset.dependencies,
        });
      }
    }

    logger.debug('Fetching manifest', sortedDeps);
    this.manifest = await fetchManifest(sortedDeps);
    logger.debug('fetched manifest', this.manifest);
  }

  async preloadModules(): Promise<void> {
    await Promise.all(
      this.manifest.map((dep) => {
        return this.fetchNodeModule(dep.n, dep.v);
      })
    );
  }

  private async _fetchModule(name: string, version: string): Promise<NodeModule> {
    // Prefer the zip-bundled content (R3-49a); fall back to the live CDN fetch.
    const module = (await this._fetchBundledModule(name, version)) ?? (await fetchModule(name, version));
    const processedNodeModule = new NodeModule(name, version, module.f, module.m);
    this.modules.set(name, processedNodeModule);
    logger.debug('fetched module', name, version, module);
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
