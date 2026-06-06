import { BundlerError } from '../errors/BundlerError';
import { FileSystem } from '../FileSystem';
import { MemoryFSLayer } from '../FileSystem/layers/MemoryFSLayer';
import { NodeModuleFSLayer } from '../FileSystem/layers/NodeModuleFSLayer';
import { ZenFSLayer } from '../FileSystem/layers/ZenFSLayer';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { AuthService } from '../auth/AuthService';
import { ThemeService } from '../theme/ThemeService';
import { FormFactorService } from '../formFactor/FormFactorService';
import { EditorContextService } from '../editor/EditorContextService';
import { CatalogService } from '../catalog/CatalogService';
import { MountService } from '../mounts/MountService';
import { APP_ROOT, MANIFEST_SIDECAR_PATH, underAppRoot, stripAppRoot } from '../fsLayout';
import { BundlerStatus } from '../protocol/message-types';
import { ResolverCache, resolveAsync } from '../resolver/resolver';
import { selfHostVersion, fetchVendoredModule } from './registryResolvedModules';
import { IPackageJSON, ISandboxFile } from '../types';
import { DelayedEmitter, Emitter } from '../utils/emitter';
import { replaceHTML } from '../utils/html';
import * as logger from '../utils/logger';
import { NamedPromiseQueue } from '../utils/NamedPromiseQueue';
import { nullthrows } from '../utils/nullthrows';
import { ModuleRegistry } from './module-registry';
import { LocksetSection, validateLockset } from './module-registry/lockset';
import { Module } from './module/Module';
import { Preset } from './presets/Preset';
import { getPreset } from './presets/registry';
import { retryFetch, registerImmutableUrlPrefix } from '../utils/fetch'
import { basename } from '../utils/path'
import { FrontmatterParseResult, parseFrontmatter } from './frontmatter';
import { bindContext, globToRegex } from '@zenfs/core';

export type TransformationQueue = NamedPromiseQueue<Module>;
export type MetadataChange = {
  type: 'metadata-update',
  update: Record<string, Record<string, any>>
};

// Self-hosted, versioned packages the bundler resolves from an origin we control
// instead of the sandpack CDN (SDK_PACKAGING_SPEC §5). Files live under
// `<base>/v/<version>/` — the SDK's release CI publishes its `dist/` + a
// `manifest.json` there. Self-hosting makes the pinned version available the
// instant our own CI finishes (immune to npm→CDN replication lag) over an
// SRI-able origin, and is the SOLE delivery path: there is no host-injected
// singleton anymore (copy-sdk.sh / static vendoring removed). Resolution is
// implicit — see `addLocalModules`.
const SELF_HOST_BASES: Record<string, string> = {
  '@immediately-run/sdk': 'https://immediately-run.github.io/immediately-run-sdk',
};

// The version fetched for a self-hosted module when the app does not pin a
// concrete one (no declaration, or a non-concrete range). Must be a version the
// SDK release CI has published to `/v/<version>/`. Bump on SDK releases.
const DEFAULT_SDK_VERSION = '0.2.8';

// Each self-host `/v/<version>/` path encodes the exact version, so its
// responses are immutable and may be served cache-first from the persistent
// (parent-side) cache. Register the `/v/` prefix so retryFetch routes it through
// that cache — and keep it in sync with the parent's IMMUTABLE_URL_ALLOWLIST
// (immediately-run-sandpack immutable-fetch-protocol.ts), which gates what the
// parent will fetch on the opaque-origin iframe's behalf.
for (const base of Object.values(SELF_HOST_BASES)) {
  registerImmutableUrlPrefix(`${base.replace(/\/$/, '')}/v/`);
}

export const DEFAULT_CODE = `
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
`.trim()

/**
 * Source for the sandbox's `fs` module. It re-exports the shared filesystem the
 * bundler exposes on the global. That fs is rooted at `/` (so app code can reach
 * the whole tree, including dynamic mounts like `/firestore`) with the working
 * directory at `APP_ROOT`, so relative paths resolve against the repo. The repo
 * is backed by the parent window over the ZenFS Port, so app-code writes there
 * land in the parent filesystem and are reflected back into the editor. Async
 * APIs (\`fs.promises.*\`, callback style) are supported; synchronous APIs are
 * not, since the Port bridge cannot service synchronous calls.
 */
export const SHARED_FS_MODULE_CODE = `
"use strict";
var __fs = (typeof globalThis !== "undefined" && globalThis.__sandpackSharedFs) || null;
if (!__fs) {
  throw new Error("[sandpack] shared filesystem is unavailable");
}
module.exports = __fs;
`.trim()

interface IBundlerOpts {
  messageBus: IFrameParentMessageBus;
  auth: AuthService;
  theme: ThemeService;
  editorContext: EditorContextService;
  catalog: CatalogService;
  formFactor: FormFactorService;
  mounts: MountService;
}

const extractMetadata = (file: ISandboxFile):(FrontmatterParseResult|null) => {
    if (file.path.endsWith('.mdx')) {
      try {
        const parseResult = parseFrontmatter(file.code);
        if (Object.keys(parseResult.data).length > 0) {
          return parseResult;
        }
      } catch (e) {
        console.warn(`Error parsing metadata for ${file.path}`, e);
      }
    }
    return null;
  }

export class Bundler {
  private lastHTML: string | null = null;
  // Public so transformers reached via `Transformer#init(bundler)` can use the
  // parent handshake — the `BabelTransformer` needs `getBabelPort()`.
  messageBus: IFrameParentMessageBus;

  // Auth/account state mirrored from the parent. App code reaches it via the
  // SDK at `module.evaluation.module.bundler.auth` (same path it already uses
  // for `messageBus` / `onMetadataChange`).
  auth: AuthService;

  // Host UI theme mirrored from the parent. Reached by app code via the SDK at
  // `module.evaluation.module.bundler.theme` (getHostTheme / useHostTheme).
  theme: ThemeService;

  // Editor context (the dirty set, §5.3) mirrored from the parent. Reached via
  // the SDK at `module.evaluation.module.bundler.editorContext` (useEditorContext).
  editorContext: EditorContextService;

  // Method catalog (§5.5) mirrored from the parent. Reached via the SDK at
  // `module.evaluation.module.bundler.catalog` (useCatalog).
  catalog: CatalogService;

  // Form factor of the rendered surface, mirrored from the parent. Reached via
  // the SDK at `module.evaluation.module.bundler.formFactor` (useFormFactor).
  formFactor: FormFactorService;

  // Mounts available to the sandbox, mirrored from the parent. Reached by app
  // code via the SDK at `module.evaluation.module.bundler.mounts`.
  mounts: MountService;

  fs: FileSystem;
  moduleRegistry: ModuleRegistry;

  parsedPackageJSON: IPackageJSON | null = null;
  // Map filepath => Module
  modules: Map<string, Module> = new Map();
  transformationQueue: TransformationQueue;
  resolverCache: ResolverCache = new Map();
  // Filepaths of modules whose evaluation is in progress (synchronous require
  // chain), used by Module.evaluate to detect import cycles instead of
  // recursing into a stack overflow.
  evaluationStack: string[] = [];
  hasHMR = false;
  isFirstLoad = true;
  preset: Preset | undefined;

  // Map from module id => parent module ids
  initiators = new Map<string, Set<string>>();
  runtimes: string[] = [];

  private onMetadataChangeEmitter = new DelayedEmitter<MetadataChange>();
  onMetadataChange = this.onMetadataChangeEmitter.event;

  private onStatusChangeEmitter = new Emitter<BundlerStatus>();
  onStatusChange = this.onStatusChangeEmitter.event;

  private _previousDepString: string | null = null;
  private zenFsLayer: ZenFSLayer;
  private lastMetadata: Map<string, Record<string, any>> = new Map();

  /**
   * Records files the parent reported as changed. ZenFS's `Port` backend does
   * not forward watch events across the iframe boundary, so the bundler cannot
   * observe parent-side writes on its own — the parent relays the changed paths
   * (see the `fs-change` handler in `index.ts`). This invalidates the cached
   * contents and queues the paths for the next incremental compile.
   */
  markFilesChanged(paths: string[]): void {
    this.zenFsLayer.markChanged(paths);
  }

  constructor(options: IBundlerOpts) {
    this.transformationQueue = new NamedPromiseQueue(true, 50);
    this.moduleRegistry = new ModuleRegistry(this);
    const memoryFS = new MemoryFSLayer();
    // In-memory write resolves synchronously, so we don't need to await it here.
    void memoryFS.writeFile('//empty.js', 'module.exports = () => {};');
    // Bind at the filesystem root (not just the repo) so module resolution can
    // reach the whole tree — the repo lives at `APP_ROOT` and dynamic mounts
    // (e.g. `/firestore`) appear as siblings. Repo-relative reads below are
    // anchored to `APP_ROOT` explicitly.
    this.zenFsLayer = new ZenFSLayer(bindContext({'root': '/', 'pwd': '/'}));
    this.fs = new FileSystem([memoryFS, this.zenFsLayer, new NodeModuleFSLayer(this.moduleRegistry)]);
    this.messageBus = options.messageBus;
    this.auth = options.auth;
    this.theme = options.theme;
    this.editorContext = options.editorContext;
    this.catalog = options.catalog;
    this.formFactor = options.formFactor;
    this.mounts = options.mounts;
  }

  /** Reset all compilation data */
  resetModules(): void {
    this.preset = undefined;
    this.modules = new Map();
    this.resolverCache = new Map();
  }

  async initPreset(preset: string): Promise<void> {
    if (!this.preset) {
      this.preset = getPreset(preset);
      await this.preset.init(this);
    }
  }

  async registerRuntime(id: string, code: string): Promise<void> {
    const filepath = `/node_modules/__csb_runtimes/${id}.js`;
    await this.fs.writeFile(filepath, code);
    const module = new Module(filepath, code, false, this);
    this.modules.set(filepath, module);
    this.runtimes.push(filepath);
  }

  getModule(filepath: string): Module | undefined {
    return this.modules.get(filepath);
  }

  enableHMR(): void {
    this.hasHMR = true;
  }

  getInitiators(id: string): Set<string> {
    return this.initiators.get(id) ?? new Set();
  }

  addInitiator(moduleId: string, initiatorId: string): void {
    const initiators = this.getInitiators(moduleId);
    initiators.add(initiatorId);
    this.initiators.set(moduleId, initiators);
  }

  async processPackageJSON(): Promise<void> {
    const foundPackageJSON = await this.fs.readFileAsync(underAppRoot('/package.json'));
    try {
      this.parsedPackageJSON = JSON.parse(foundPackageJSON);
    } catch (err) {
      // Makes the bundler a bit more error-prone to invalid pkg.json's
      if (!this.parsedPackageJSON) {
        throw err;
      }
    }
  }

  async resolveEntryPoint(): Promise<string> {
    if (!this.parsedPackageJSON) {
      throw new BundlerError('No parsed package.json found!');
    }

    if (!this.preset) {
      throw new BundlerError('Preset has not been loaded yet');
    }

    const potentialEntries = new Set(
      [
        this.parsedPackageJSON.main,
        this.parsedPackageJSON.source,
        this.parsedPackageJSON.module,
        ...this.preset.defaultEntryPoints,
      ].filter((e) => typeof e === 'string')
    );

    for (let potentialEntry of potentialEntries) {
      if (typeof potentialEntry === 'string') {
        try {
          // Entry paths from package.json (and preset defaults) are
          // repo-relative. The bundler fs is now rooted at `/`, so anchor them
          // to `APP_ROOT`: an absolute entry like `/index.tsx` means the repo's
          // `/app/index.tsx`, and relative/bare entries resolve against an
          // `APP_ROOT` base.
          const entryPoint =
            potentialEntry[0] === '/'
              ? underAppRoot(potentialEntry)
              : potentialEntry[0] !== '.'
              ? `./${potentialEntry}`
              : potentialEntry;
          const resolvedEntryPont = await this.resolveAsync(entryPoint, underAppRoot('/index.js'));
          return resolvedEntryPont;
        } catch (err) {
          logger.debug(`Could not resolve entrypoint ${potentialEntry}`);
          logger.debug(err);
        }
      }
    }
    throw new BundlerError(
      `Could not resolve entry point, potential entrypoints: ${Array.from(potentialEntries).join(
        ', '
      )}. You can define one by changing the "main" field in package.json.`
    );
  }

  /**
   * Best-effort read of the cache zip's sidecar lockset
   * (PRETRANSPILED_ARTIFACTS_SPEC §5.4). The sidecar exists inside the mounted
   * repo only when it was loaded from a cache zip — REST loads keep their
   * manifest outside the mount — so this scopes the optimization to exactly
   * the zip path. Any read/parse/validation failure means "no lockset" and the
   * registry resolves dependencies live, as before.
   */
  private async readSidecarLockset(): Promise<LocksetSection | undefined> {
    try {
      const raw = await this.fs.readFileAsync(underAppRoot(MANIFEST_SIDECAR_PATH));
      return validateLockset((JSON.parse(raw) as { lockset?: unknown }).lockset) ?? undefined;
    } catch (err) {
      return undefined;
    }
  }

  async loadNodeModules() {
    if (!this.parsedPackageJSON) {
      throw new BundlerError('No parsed pkg.json found!');
    }

    let dependencies = this.parsedPackageJSON.dependencies;
    if (dependencies) {
      // Self-hosted (resolveFromRegistry) modules are already registered as
      // local modules by addLocalModules; strip them so the CDN /dep_tree/ query
      // never has to resolve them (immune to npm→CDN replication lag). Their own
      // transitive deps are added by the preset augmentation below regardless.
      const registryResolved = this.registryResolvedNames();
      if (registryResolved.size) {
        dependencies = Object.fromEntries(
          Object.entries(dependencies).filter(([name]) => !registryResolved.has(name))
        );
      }
      dependencies = nullthrows(
        this.preset,
        'Preset needs to be defined when loading node modules'
      ).augmentDependencies(dependencies);

      await this.moduleRegistry.fetchManifest(dependencies, true, await this.readSidecarLockset());

      // Load all modules
      await this.moduleRegistry.preloadModules();
      await this.moduleRegistry.loadModuleDependencies();
    }
  }

  async resolveAsync(
    specifier: string,
    filename: string,
    extensions: string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mdx']
  ): Promise<string> {
    try {
      const resolved = await resolveAsync(specifier, {
        filename,
        extensions,
        isFile: this.fs.isFile,
        readFile: this.fs.readFile,
        resolverCache: this.resolverCache,
      });
      return resolved;
    } catch (err) {
      logger.error(err);
      logger.error(Array.from(this.modules));
      // logger.error(Array.from(this.fs.files));
      throw err;
    }
  }

  private async _transformModule(path: string): Promise<Module> {
    let module = this.modules.get(path);
    if (module) {
      if (module.compiled != null) {
        return Promise.resolve(module);
      } else {
        // compilation got reset, we re-read the source to ensure it's the latest version.
        // reset happens mostly when we receive changes from the editor, so this ensures we actually output the changes...
        module.source = await this.fs.readFileAsync(path);
      }
    } else {
      const content = await this.fs.readFileAsync(path);
      module = new Module(path, content, false, this);
      this.modules.set(path, module);
    }
    this.refreshMetadata(path, module.source);
    await module.compile();
    for (let dep of module.dependencies) {
      const resolvedDependency = await this.resolveAsync(dep, module.filepath);
      this.transformModule(resolvedDependency);
    }
    return module;
  }

  /** Transform file at a certain absolute path */
  async transformModule(path: string): Promise<Module> {
    let module = this.modules.get(path);
    if (module && module.compiled != null) {
      return Promise.resolve(module);
    }
    return this.transformationQueue.addEntry(path, () => {
      return this._transformModule(path);
    });
  }

  async moduleFinishedPromise(id: string, moduleIds: Set<string> = new Set()): Promise<any> {
    if (moduleIds.has(id)) return;

    const foundPromise = this.transformationQueue.getItem(id);
    if (foundPromise) {
      await foundPromise;
    }

    const asset = this.modules.get(id);
    if (!asset) {
      throw new BundlerError(`Asset not in the compilation tree ${id}`);
    } else {
      if (asset.compilationError != null) {
        throw asset.compilationError;
      } else if (asset.compiled == null) {
        throw new BundlerError(`Asset ${id} has not been compiled`);
      }
    }

    moduleIds.add(id);

    for (const dep of asset.dependencies) {
      if (!moduleIds.has(dep)) {
        try {
          await this.moduleFinishedPromise(dep, moduleIds);
        } catch (err) {
          logger.debug(`Failed awaiting transpilation ${dep} required by ${id}`);

          throw err;
        }
      }
    }
  }

  private getNodeModuleFiles(moduleName: string, code?: string, packageJSON?: string): [string, string][] {
    return [
      [`/node_modules/${moduleName}/package.json`, packageJSON ?? JSON.stringify({
        name: moduleName,
        main: "./index.js",
      })],
      [`/node_modules/${moduleName}/index.js`, code ?? DEFAULT_CODE]
    ]
  }

  async addPreloadedModule(moduleName: string, code?: string, packageJSON?: string): Promise<void> {
    const files = this.getNodeModuleFiles(moduleName, code, packageJSON);
    const manifest = files.filter(([filename, _]) => basename(filename) === 'package.json')
    if (manifest.length !== 1) {
      throw Error('addPreloadedModule did not find manifest for ' + moduleName);
    }
    const parsedPackageJSON: any = JSON.parse(manifest[0][1]);
    for (let [filepath, contents] of files) {
      await this.fs.writeFile(filepath, contents);
      if (filepath.endsWith('.js')) {
        const module = new Module(filepath, contents, false, this);
        this.modules.set(filepath, module);
      }
    }
  }

  async preloadModules(): Promise<void> {
    await Promise.all([
      this.addPreloadedModule("path"),
      // `fs` is backed by the shared filesystem (parent window over the Port),
      // not a CDN polyfill — so app-code writes reach the parent and reflect in
      // the editor.
      this.addPreloadedModule("fs", SHARED_FS_MODULE_CODE),
      this.addPreloadedModule("util"),
      this.addPreloadedModule("assert"),
      this.addPreloadedModule("module"),
      this.addPreloadedModule("os"),
      // this.addPreloadedModule("@internationalized/date"),
    ]);
  }

  async fetchSource(url: string): Promise<string> {
    return await (await retryFetch(url)).text()
  }

  /**
   * Best-effort read of the app's package.json (used by `addLocalModules`, which
   * runs before `processPackageJSON`). Returns `''` on any failure so callers
   * treat it as "no opt-in" and the default injection path is preserved.
   */
  private async readPackageJsonRaw(): Promise<string> {
    try {
      return await this.fs.readFileAsync(underAppRoot('/package.json'));
    } catch {
      return '';
    }
  }

  /**
   * Fetch a module's `manifest.json` + listed files from `baseUrl` and register
   * them as local modules under `/node_modules/<moduleName>/`. The manifest's
   * file list is generated alongside the files (by the SDK release CI's
   * build-selfhost.mjs), so it cannot drift from the directory contents.
   */
  private async vendorModuleFrom(moduleName: string, baseUrl: string): Promise<void> {
    const vendored = await fetchVendoredModule(moduleName, baseUrl, (url) => this.fetchSource(url));
    for (const { path, content, isModule } of vendored) {
      await this.fs.writeFile(path, content);
      if (isModule) {
        this.modules.set(path, new Module(path, content, false, this));
      }
    }
  }

  async addLocalModules(): Promise<void> {
    // Resolve each self-hosted module (the SDK) from its versioned gh-pages
    // location and register its files as local modules. IMPLICIT (no opt-in):
    // the app's pinned dependency version wins, else DEFAULT_SDK_VERSION — so the
    // SDK always resolves as a plain dependency with no `resolveFromRegistry`
    // ceremony. This is the SOLE delivery path; the host-injected singleton
    // (copy-sdk.sh vendoring) is gone. Read package.json directly because this
    // runs before `processPackageJSON`.
    const raw = await this.readPackageJsonRaw();
    for (const [moduleName, base] of Object.entries(SELF_HOST_BASES)) {
      const version = selfHostVersion(raw, moduleName, DEFAULT_SDK_VERSION);
      const baseUrl = `${base.replace(/\/$/, '')}/v/${version}`;
      logger.debug(`Resolving ${moduleName}@${version} from self-host ${baseUrl}`);
      await this.vendorModuleFrom(moduleName, baseUrl);
    }
  }

  /**
   * Names resolved from a self-hosted versioned location (those `addLocalModules`
   * registered as local modules). They must be removed from the dependency map
   * before the sandpack-CDN `/dep_tree/` query — otherwise an SDK version not yet
   * replicated npm→CDN would fail resolution for the whole app. Mirrors the CLI
   * lockset's `computeInputDepMap` stripping so the lockset echo-match still
   * holds. Self-hosting is implicit, so every `SELF_HOST_BASES` key is stripped.
   */
  private registryResolvedNames(): Set<string> {
    return new Set(Object.keys(SELF_HOST_BASES));
  }

  async preloadMDXMetadata(): Promise<void> {
    const re = globToRegex('/**/*.mdx');
    const zenFsLayer = this.fs.layers[1] as ZenFSLayer;
    // Scan only the repo (`APP_ROOT`), not the whole filesystem — dynamic mounts
    // (e.g. `/firestore`) and virtual node_modules aren't sources of app MDX.
    const mdxFiles = (await zenFsLayer.boundContext.fs.promises.readdir(APP_ROOT, {recursive: true})).map(
      i => underAppRoot('/' + i)).filter(p => p.match(re));
    await Promise.all(mdxFiles.map(async (filepath) => {
      const source = await zenFsLayer.readFileAsync(filepath);
      this.refreshMetadata(filepath, source);
    }));
  }


  /**
   * Lazily extracts MDX frontmatter metadata when a file is (re-)read during
   * compilation. Fires `onMetadataChange` if the parsed metadata differs from
   * the last value observed for the same path.
   */
  private refreshMetadata(path: string, source: string): void {
    const parsed = extractMetadata({ path, code: source });
    const next = parsed ? parsed.data : undefined;
    // Metadata is keyed by the repo-relative path apps and the URL space use
    // (the bundler fs is rooted at `/`, so module paths are `/app/...`).
    const publicPath = stripAppRoot(path);
    const prev = this.lastMetadata.get(publicPath);

    const prevKey = prev ? JSON.stringify(prev) : undefined;
    const nextKey = next ? JSON.stringify(next) : undefined;
    if (prevKey === nextKey) {
      return;
    }

    if (next) {
      this.lastMetadata.set(publicPath, next);
    } else {
      this.lastMetadata.delete(publicPath);
    }
    this.onMetadataChangeEmitter.fire({
      type: 'metadata-update',
      update: { [publicPath]: next ?? {} },
    });
  }

  /**
   * Returns the set of paths that changed since the last compile (as reported
   * by the zenfs watcher). Also invalidates the corresponding modules so the
   * transform queue re-reads them.
   */
  private collectChangedFiles(): string[] {
    return this.zenFsLayer.drainPendingChanges();
  }

  async compile(): Promise<() => any> {
    if (!this.preset) {
      throw new BundlerError('Cannot compile before preset has been initialized');
    }

    this.onStatusChangeEmitter.fire('installing-dependencies');

    // TODO: Have more fine-grained cache invalidation for the resolver
    // Reset resolver cache
    this.resolverCache = new Map();
    this.fs.resetCache();

    let changedFiles: string[] = [];
    if (!this.isFirstLoad) {
      logger.debug('Started incremental compilation');

      changedFiles = this.collectChangedFiles();

      if (!changedFiles.length) {
        logger.debug('Skipping compilation, no changes detected');
        return () => { };
      }

      // If it's a change and we don't have any hmr modules we simply reload the
      // application. package.json is exempt: it can't be hot-applied anyway and
      // is handled below (`pkgJsonChanged` re-checks the dependencies and
      // reloads only if they actually changed). Without the exemption, a no-op
      // package.json rewrite by the parent (addPackageJSONIfNeeded runs on
      // every register-frame handshake) arrives as an fs-change right after
      // boot — before the app evaluated and registered HMR — and forces a
      // reload, whose handshake rewrites package.json again: an infinite
      // reload loop.
      const changesNeedingHMR = changedFiles.filter((f) => f !== underAppRoot('/package.json'));
      if (!this.hasHMR && changesNeedingHMR.length) {
        logger.debug('HMR is not enabled, doing a full page refresh');
        window.location.reload();
        return () => { };
      }
    } else {
      // First load: files are read lazily from zenfs as the bundler traverses
      // from the entrypoint. Only preloaded/local node_modules are written up
      // front here.
      await this.preloadModules();
      await this.addLocalModules();
      // Drain any spurious watcher events that fired during bootstrap so they
      // aren't interpreted as user-driven changes later.
      this.zenFsLayer.drainPendingChanges();
      // update MDX metadata for files which need to be picked up on startup
      // TODO: make this glob pattern overridable from package.json
      await this.preloadMDXMetadata();
    }

    if (changedFiles.length) {
      const promises = [];
      for (let changedFile of changedFiles) {
        const module = this.getModule(changedFile);
        if (module) {
          module.resetCompilation();
          promises.push(this.transformModule(changedFile));
        }
      }
      await Promise.all(promises);
    }

    const pkgJsonChanged = changedFiles.find((f) => f === underAppRoot('/package.json'));
    if (this.isFirstLoad || pkgJsonChanged) {
      logger.debug('Loading node modules');
      await this.processPackageJSON();

      const depString = Object.entries(this.parsedPackageJSON?.dependencies || {})
        .map((v) => `${v[0]}:${v[1]}`)
        .sort()
        .join(',');

      if (this._previousDepString != null && depString !== this._previousDepString) {
        logger.debug('Dependencies changed, reloading');
        location.reload();
        return () => { };
      }

      this._previousDepString = depString;

      await this.loadNodeModules();
    }

    this.onStatusChangeEmitter.fire('transpiling');

    // Transform runtimes
    if (this.isFirstLoad) {
      for (const runtime of this.runtimes) {
        await this.transformModule(runtime);
        await this.moduleFinishedPromise(runtime);
      }
    }

    // Resolve entrypoints
    const resolvedEntryPoint = await this.resolveEntryPoint();
    logger.debug('Resolved entrypoint:', resolvedEntryPoint);

    // Transform entrypoint and deps
    const entryModule = await this.transformModule(resolvedEntryPoint);
    await this.moduleFinishedPromise(resolvedEntryPoint);
    logger.debug('Bundling finished, manifest:');
    logger.debug(this.modules);

    entryModule.isEntry = true;

    const transpiledModules = Array.from(this.modules, ([name, value]) => {
      return {
        /**
         * TODO: adds trailing for backwards compatibility
         */
        [name + ':']: {
          source: {
            isEntry: entryModule.filepath === value.filepath,
            fileName: value.filepath,
            compiledCode: value.compiled,
          },
        },
      };
    }).reduce((prev, curr) => {
      return { ...prev, ...curr };
    }, {});

    this.messageBus.sendMessage('state', { state: { transpiledModules } });

    return () => {
      // Evaluate
      logger.debug('Evaluating...');

      if (this.isFirstLoad) {
        for (const runtime of this.runtimes) {
          const module = this.modules.get(runtime);
          if (!module) {
            throw new BundlerError(`Runtime ${runtime} is not defined`);
          } else {
            logger.debug(`Loading runtime ${runtime}...`);
            module.evaluate();
          }
        }

        entryModule.evaluate();
        this.isFirstLoad = false;
      } else {
        this.modules.forEach((module) => {
          if (module.hot.hmrConfig?.isDirty()) {
            module.evaluate();
          }
        });

        // TODO: Validate that this logic actually works...
        // Check if any module has been invalidated, because in that case we need to
        // restart evaluation.
        const invalidatedModules = Object.values(this.modules).filter((m: Module) => {
          if (m.hot.hmrConfig?.invalidated) {
            m.resetCompilation();
            this.transformModule(m.filepath);
            return true;
          }

          return false;
        });

        if (invalidatedModules.length > 0) {
          return this.compile();
        }
      }
    };
  }

  // TODO: Support template languages...
  async getHTMLEntry(): Promise<string> {
    let content = undefined;
    for (const filepath of [underAppRoot('/index.html'), underAppRoot('/public/index.html')]) {
      try {
        content = await this.fs.readFileAsync(filepath);
      } catch (err) {
      }
      if (content) {
        return content;
      }
    }
    // fall back to preset default
    if (!this.preset) {
      throw new BundlerError('Bundler has not been initialized with a preset');
    }
    return this.preset.defaultHtmlBody;
  }

  async replaceHTML() {
    const html = (await this.getHTMLEntry()) ?? '<div id="root"></div>';
    if (this.lastHTML) {
      if (this.lastHTML !== html) {
        window.location.reload();
      }
      return;
    } else {
      this.lastHTML = html;
      replaceHTML(html);
    }
  }
}
