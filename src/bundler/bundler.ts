import { BundlerError } from '../errors/BundlerError';
import { CachedFS } from '../FileSystem/CachedFS';
import { RegistryFS, RegistryFileFetcher } from '../FileSystem/RegistryFS';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { AuthService } from '../auth/AuthService';
import { ThemeService } from '../theme/ThemeService';
import { FormFactorService } from '../formFactor/FormFactorService';
import { EditorContextService } from '../editor/EditorContextService';
import { CatalogService } from '../catalog/CatalogService';
import { MountService } from '../mounts/MountService';
import { APP_ROOT, MANIFEST_SIDECAR_PATH, underAppRoot } from '../fsLayout';
import { isTransformable } from '@immediately-run/transpiler';
import { ArtifactStore } from './artifacts/artifactStore';
import { getEmbeddedToolchain } from './artifacts/embeddedToolchain';
import { BundlerStatus } from '../protocol/message-types';
import { ResolverCache, resolveAsync } from '../resolver/resolver';
import { resolveSelfHostVersion, fetchVendoredModule, SelfHostResolutionError, type VendorTiming } from './registryResolvedModules';
import { gitDependencyNames } from './gitDependency';

// Module-level monotonic clock for the `[ir-perf:addlocal]` sub-phase breakdown
// (LOAD_PROFILING_SPEC §2 phase 3) — falls back to Date.now when unavailable.
const vendorBootNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
import { verifyVendoredFiles, decideIntegrity, type SdkIntegrity, type FileHashes } from './sdkIntegrity';
import { MountLifecycle, type MountContext } from './mountLifecycle';
import { IPackageJSON, ISandboxFile } from '../types';
import { DelayedEmitter, Emitter } from '../utils/emitter';
import { replaceHTML } from '../utils/html';
import * as logger from '../utils/logger';
import { NamedPromiseQueue } from '../utils/NamedPromiseQueue';
import { nullthrows } from '../utils/nullthrows';
import { ModuleRegistry } from './module-registry';
import { resolveFromCdnLayout } from './module-registry/cdnLayoutResolve';
import { LocksetSection, validateLockset } from './module-registry/lockset';
import { collectLocalEntrySideEffects } from './sideEffectImports';
import { Module } from './module/Module';
import { Preset } from './presets/Preset';
import { getPreset } from './presets/registry';
import { emitPerfMarker } from './perfMarkers';
import { retryFetch, registerImmutableUrlPrefix } from '../utils/fetch'
import { basename, dirname } from '../utils/path'
import { FrontmatterParseResult, parseFrontmatter } from '@immediately-run/transpiler';
import { bindContext, globToRegex, CopyOnWrite, InMemory, mount, resolveMountConfig, fs as zenfs } from '@zenfs/core';

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

// The version fetched for a self-hosted module when the app declares no SDK
// dependency at all (SDK_PACKAGING_SPEC §5.1(c) — a declared-but-non-concrete
// specifier fails closed instead, see resolveSelfHostVersion). Must be a
// version the SDK release CI has published to `/v/<version>/`. Should always
// track the latest published SDK at deploy time; bump it on every SDK release
// (the host's sdk-integrity manifest auto-covers up to the newest tag).
const DEFAULT_SDK_VERSION = '0.16.0';

// Oldest version each self-hosted module may pin (SDK_PACKAGING_SPEC §5.1(b)).
// Pins below the floor fail closed at resolve time: 0.2.7 ships a fatal
// sandboxUtils↔runtime import cycle that infinite-loops this bundler at boot
// ("Maximum call stack size exceeded"), so booting it would crash anyway —
// fail with a clear error instead.
const SELF_HOST_FLOORS: Record<string, string> = {
  '@immediately-run/sdk': '0.2.8',
};

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

  fs: CachedFS;
  /** Pre-transpiled artifact seeding/consult/write-through (§5.1, §5.3). */
  artifactStore: ArtifactStore;
  moduleRegistry: ModuleRegistry;

  parsedPackageJSON: IPackageJSON | null = null;
  // The host-resolved root package.json delivered out-of-band via IInitConfig
  // (BOOT_SCAFFOLDING_SPEC §3). When set, it is the authoritative source for the
  // app manifest and the bundler does NOT read `/app/package.json` from the FS —
  // so the host need not write a synthesized `package.json` into the CoW. Null on
  // standalone Sandpack / older hosts, where the FS read remains the source.
  configPackageJSON: IPackageJSON | null = null;
  // Map filepath => Module
  modules: Map<string, Module> = new Map();
  transformationQueue: TransformationQueue;
  resolverCache: ResolverCache = new Map();
  // Resolution-RESULT cache (specifier+dir → resolved path), distinct from
  // resolverCache (which memoizes package.json/tsconfig *content*, not results).
  // The resolution algorithm is the cold-boot cost — ~3k resolveAsync calls over the
  // precompiled node_modules closure, each re-running candidate generation + probes
  // even with cached reads. Node resolution is dir-relative, so two files in the same
  // dir resolve a given specifier identically: keying by dirname dedups them. Reset
  // per compile alongside resolverCache, so edits get fresh resolution.
  resolutionCache: Map<string, Promise<string>> = new Map();
  // R3-49d CDN-layout fast path: per-package alias-eligibility verdict (immutable
  // for the closure) + fast-hit/fall-through counters (diagnostic, logged once at
  // boot). Reset per compile alongside the resolution caches.
  private cdnLayoutEligibility: Map<string, boolean> = new Map();
  private cdnFastHits = 0;
  private cdnFallThroughs = 0;
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

  // Resolved modules harvested from the local entry's (`src/main.tsx`)
  // side-effect imports — CSS, polyfills — applied before the app renders so a
  // default Vite scaffold "just works" (DG-2 / decision #27). Populated on the
  // first compile; evaluated in the first-load branch of the evaluate callback.
  private sideEffectModulePaths: string[] = [];

  private readonly mountLifecycle = new MountLifecycle();
  private onMetadataChangeEmitter = new DelayedEmitter<MetadataChange>();
  onMetadataChange = this.onMetadataChangeEmitter.event;

  private onStatusChangeEmitter = new Emitter<BundlerStatus>();
  onStatusChange = this.onStatusChangeEmitter.event;

  private _previousDepString: string | null = null;
  // Injectable RegistryFS lazy-fetch function (the G0-0 harness injects a network
  // spy so a test can observe lazy unpkg fetches). Undefined → RegistryFS uses its
  // built-in `retryFetch`-through-the-parent-cache default.
  private registryFetcher?: RegistryFileFetcher;
  // Guards `setupModuleMounts()` so the bundler-owned mounts are assembled exactly
  // once (it is called both from `index.ts` after construction and defensively at
  // the top of `compile()`).
  private mountsReady = false;
  private lastMetadata: Map<string, Record<string, any>> = new Map();
  // Host-pinned SDK integrity hashes (SDK_PACKAGING_SPEC §5.2), set from
  // IInitConfig before the initial compile; undefined → verification skipped.
  private sdkIntegrity?: SdkIntegrity;

  // The §5.2 dirty set: repo-relative paths in the COW writable layer (edited in
  // a previous session) + the journal's deleted set, pushed by the host on
  // register-frame. Consulted by artifact seeding so a dirty path is never seeded
  // (its `/app` content no longer matches the zip the artifact was built from).
  private dirtyPaths: Set<string> = new Set();

  /**
   * Records files the parent reported as changed. ZenFS's `Port` backend does
   * not forward watch events across the iframe boundary, so the bundler cannot
   * observe parent-side writes on its own — the parent relays the changed paths
   * (see the `fs-change` handler in `index.ts`). This invalidates the cached
   * contents and queues the paths for the next incremental compile.
   */
  markFilesChanged(paths: string[]): void {
    this.fs.markChanged(paths);
  }

  constructor(options: IBundlerOpts) {
    this.transformationQueue = new NamedPromiseQueue(true, 50);
    this.moduleRegistry = new ModuleRegistry(this);
    // R3-48 G0-4: the bundler reads + writes through a single ZenFS bound context.
    // Bind at the filesystem root (not just the repo) so module resolution can reach
    // the whole tree — `/app` (Port), `/node_modules` (CoW over RegistryFS) and
    // `/transpiled` (tmpfs) are mounts assembled by `setupModuleMounts()` before the
    // first compile; dynamic mounts (`/firestore`) appear as siblings. Repo-relative
    // reads below are anchored to `APP_ROOT` explicitly.
    this.fs = new CachedFS(bindContext({ root: '/', pwd: '/' }));
    this.artifactStore = new ArtifactStore(this.fs, getEmbeddedToolchain());
    this.messageBus = options.messageBus;
    this.auth = options.auth;
    this.theme = options.theme;
    this.editorContext = options.editorContext;
    this.catalog = options.catalog;
    this.formFactor = options.formFactor;
    this.mounts = options.mounts;

    // Mount-lifecycle hooks (§11.3). The MDX-frontmatter scan is the first action,
    // scoped to the app root (it skips dynamic mounts — a granted space isn't an
    // app-MDX source by default, and scanning it would be unbounded work). Future
    // post-mount behaviours register here without touching the mount sites.
    this.mountLifecycle.register({
      name: 'mdx-metadata',
      onMount: (ctx) => (ctx.isAppRoot ? this.preloadMDXMetadata() : undefined),
    });
  }

  /** Run post-mount lifecycle actions for a freshly-mounted fs (§11.3). Called by
   *  the runtime at the app-root mount (boot) and each dynamic mount. */
  runPostMount(ctx: MountContext): Promise<void> {
    return this.mountLifecycle.runMount(ctx);
  }

  /** Run pre-unmount lifecycle actions before a mount is torn down (§11.3). */
  runPreUnmount(ctx: MountContext): Promise<void> {
    return this.mountLifecycle.runUnmount(ctx);
  }

  /**
   * Inject the {@link RegistryFS} lazy-fetch function (the G0-0 harness's network
   * spy). MUST be called before {@link setupModuleMounts} mounts `/node_modules`,
   * since the fetcher is captured into the `RegistryFS` instance there.
   */
  setRegistryFetcher(fetcher: RegistryFileFetcher): void {
    this.registryFetcher = fetcher;
  }

  /**
   * Assemble the bundler-owned mount table (R3-48 G0-4, plan §G0-4 step 1):
   *
   *  - `/node_modules` = `CopyOnWrite`: a writable `InMemory` tmpfs over a read-only
   *    {@link RegistryFS} (over THIS bundler's `ModuleRegistry`). Reads are served
   *    from the registry / lazy unpkg fetch; the bundler's own writes
   *    (`registerRuntime` / `addPreloadedModule` / `addLocalModules`) land on the
   *    writable side. RegistryFS owns no journal — registry files are never deleted.
   *  - `/transpiled` = `InMemory` tmpfs (consumed in Phase 03; mounted now so the
   *    spec §3 layout is final).
   *
   * The Bundler owns this assembly (not `index.ts`) because `RegistryFS` needs this
   * bundler's `ModuleRegistry`, which is created in the constructor and circularly
   * references the bundler (plan §G0-4 note). Idempotent: safe to call from
   * `index.ts` after construction AND defensively at the top of `compile()`.
   */
  async setupModuleMounts(): Promise<void> {
    if (this.mountsReady) return;
    this.mountsReady = true;

    const nodeModulesFs = await resolveMountConfig({
      backend: CopyOnWrite,
      readable: new RegistryFS(this.moduleRegistry, this.registryFetcher),
      writable: { backend: InMemory, label: 'node_modules-writable' },
    });
    await this.materializeMountPoint('/node_modules');
    mount('/node_modules', nodeModulesFs);

    const transpiledFs = await resolveMountConfig({ backend: InMemory, label: 'transpiled' });
    await this.materializeMountPoint('/transpiled');
    mount('/transpiled', transpiledFs);

    // The resolver's empty-module shim (EMPTY_SHIM = '/empty.js', resolver/utils)
    // needs a real file to read. It lives on the root tmpfs (not a mount), written
    // once the mount table exists. Replaces the former `//empty.js` MemoryFSLayer write.
    await this.fs.writeFile('/empty.js', 'module.exports = () => {};');
  }

  /**
   * ZenFS routes paths through its mount table alone — a mount point is invisible to
   * `readdir` of its parent unless the dir exists in the underlying fs. Materialize
   * it first (mirrors `index.ts`'s helper); MUST run BEFORE `mount()`, or the mkdir
   * lands inside the freshly-mounted fs instead of the parent.
   */
  private async materializeMountPoint(path: string): Promise<void> {
    try {
      await zenfs.promises.mkdir(path, { recursive: true });
    } catch (err) {
      logger.error(`Failed to materialize mount point ${path}`, err);
    }
  }

  /** Reset all compilation data */
  resetModules(): void {
    this.preset = undefined;
    this.modules = new Map();
    this.resolverCache = new Map();
    this.resolutionCache = new Map();
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
    // BOOT_SCAFFOLDING_SPEC §3.3 — prefer the host-resolved package.json delivered
    // out-of-band; only fall back to the filesystem read when it is absent
    // (standalone Sandpack / older host).
    if (this.configPackageJSON) {
      this.parsedPackageJSON = this.configPackageJSON;
      return;
    }
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
    // Resolution result is a pure function of (specifier, the dir chain from
    // `filename` up, extensions) for the FS snapshot of this compile — node
    // resolution is dir-relative, so two files in the same dir resolve a specifier
    // identically. Memoize on that key to avoid re-running the algorithm for every
    // edge across the closure (the cold-boot cost). Cache the promise so concurrent
    // identical resolutions share one run; drop it on rejection so a miss isn't
    // cached as a permanent failure.
    const key = `${dirname(filename)}\0${specifier}\0${extensions.join(',')}`;
    const cached = this.resolutionCache.get(key);
    if (cached) return cached;
    // R3-49d: resolve relative imports inside precompiled node_modules packages
    // directly from the CDN module layout, skipping the resolution algorithm
    // entirely. Null = the fast path can't/shouldn't handle it → fall through to
    // the full resolver below (correctness degrades gracefully, never breaks).
    const fast = resolveFromCdnLayout(
      specifier,
      filename,
      extensions,
      this.moduleRegistry.modules,
      this.cdnLayoutEligibility,
    );
    if (fast !== null) {
      this.cdnFastHits++;
      const fastPromise = Promise.resolve(fast);
      this.resolutionCache.set(key, fastPromise);
      return fastPromise;
    }
    this.cdnFallThroughs++;
    const promise = resolveAsync(specifier, {
      filename,
      extensions,
      isFile: this.fs.isFile,
      readFile: this.fs.readFile,
      resolverCache: this.resolverCache,
    });
    this.resolutionCache.set(key, promise);
    promise.catch(() => this.resolutionCache.delete(key));
    try {
      return await promise;
    } catch (err) {
      // Resolution failure is re-thrown for the caller to handle. Some callers
      // probe for *optional* files (e.g. the `src/main`/`main` local-entry
      // convention in collectLocalEntrySideEffects) and catch this as expected
      // control flow — so logging at `error` here spams the console (and the
      // operator security-events stream) for a non-error. Genuine unresolved
      // imports on the compile path are surfaced + logged at the compile
      // boundary (runCompile's catch → show-error overlay). Keep the resolver
      // trace at `debug` only.
      logger.debug('resolveAsync failed', err);
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
      // §5.3 consult: a covered app source may already be transpiled in
      // `/transpiled` (seeded at boot, or written through earlier this session). A
      // HIT skips the Babel chain entirely — a seeded module is never transpiled
      // live (the §9 "zero babel transforms" criterion). Continue graph traversal
      // from the index's deps exactly as a precompiled CDN module does.
      if (isTransformable(path)) {
        const hit = await this.artifactStore.consult(path);
        if (hit) {
          const seededModule = new Module(path, hit.content, true, this);
          this.modules.set(path, seededModule);
          await Promise.all(hit.deps.map((dep) => seededModule.addDependency(dep)));
          for (const dep of seededModule.dependencies) {
            this.transformModule(dep);
          }
          return seededModule;
        }
      }
      const content = await this.fs.readFileAsync(path);
      module = new Module(path, content, false, this);
      this.modules.set(path, module);
    }
    this.refreshMetadata(path, module.source);
    await module.compile();
    // §5.3 write-through: cache a live-transpiled covered source so an in-session
    // re-read that didn't reset THIS module hits the tmpfs instead of the chain.
    if (module.compiled != null && module.compilationError == null && isTransformable(path)) {
      await this.artifactStore.writeThrough(path, module.compiled, [...module.dependencyMap.keys()]);
    }
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

  async fetchSource(url: string, integrity?: string): Promise<string> {
    // `pinnedSri` makes the immutable cache integrity-aware for this URL: it
    // never serves or persists bytes that don't match (cache-poisoning
    // prevention). Undefined for unpinned URLs (cached by URL as before).
    return await (await retryFetch(url, { pinnedSri: integrity })).text()
  }

  /**
   * Best-effort read of the app's package.json (used by `addLocalModules`, which
   * runs before `processPackageJSON`). Returns `''` on any failure so callers
   * treat it as "no opt-in" and the default injection path is preserved.
   */
  private async readPackageJsonRaw(): Promise<string> {
    // Honour the out-of-band package.json here too (BOOT_SCAFFOLDING_SPEC §3.3):
    // addLocalModules runs before processPackageJSON, so it can't read
    // `this.parsedPackageJSON` yet — consult the config object directly.
    if (this.configPackageJSON) {
      return JSON.stringify(this.configPackageJSON);
    }
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
  private async vendorModuleFrom(
    moduleName: string,
    baseUrl: string,
    expectedHashes?: FileHashes,
    timing?: VendorTiming,
  ): Promise<void> {
    const vendored = await fetchVendoredModule(
      moduleName,
      baseUrl,
      (url, integrity) => this.fetchSource(url, integrity),
      expectedHashes,
      timing,
    );
    // SDK_PACKAGING_SPEC §5.2: when the host pinned hashes for this version,
    // verify the fetched bytes BEFORE writing/registering anything — fail the
    // boot closed on any mismatch (a tampered self-host origin must not run).
    const tVerify0 = vendorBootNow();
    if (expectedHashes) {
      const prefix = `/node_modules/${moduleName}/`;
      const result = await verifyVendoredFiles(
        vendored.map((v) => ({ rel: v.path.startsWith(prefix) ? v.path.slice(prefix.length) : v.path, content: v.content })),
        expectedHashes,
      );
      if (!result.ok) {
        console.warn(`[security] sdk-integrity:mismatch ${moduleName}`, {
          mismatches: result.mismatches,
          missing: result.missing,
        });
        throw new SelfHostResolutionError(
          `${moduleName} failed integrity verification (${[...result.mismatches, ...result.missing].join(', ')}). ` +
            `The self-hosted SDK bytes do not match the host-pinned hashes. ` +
            `(SDK_PACKAGING_SPEC §5.2: verification fails closed.)`,
        );
      }
    }
    const tWrite0 = vendorBootNow();
    for (const { path, content, isModule } of vendored) {
      await this.fs.writeFile(path, content);
      if (isModule) {
        this.modules.set(path, new Module(path, content, false, this));
      }
    }
    if (timing) {
      timing.verifyMs += tWrite0 - tVerify0;
      timing.writeMs += vendorBootNow() - tWrite0;
    }
  }

  /**
   * Register a git-dependency library's files as a LOCAL module under
   * `/node_modules/<name>/` (LIBRARY_MOUNTS_SPEC §2.1 L2). This is the
   * registration path that settles Q2: the library is delivered the same proven
   * way `addLocalModules`/`vendorModuleFrom` deliver the SDK — write the files on
   * the CoW writable side and register the module files as bundler `Module`s — so
   * the resolver finds the package by standard node resolution AHEAD of the
   * RegistryFS/CDN (NOT a ZenFS sub-mount under the existing `/node_modules` CoW,
   * whose precedence is uncertain).
   *
   * `files[].path` is relative to the package root (e.g. `package.json`,
   * `dist/index.js`). The name is stripped from the CDN `/dep_tree/` query by
   * `registryResolvedNames()` (git deps). Not wired into the boot sequence — L3's
   * host-mount step calls this; L2 provides it and proves resolution + no-CDN.
   */
  async addGitDependencyModule(
    name: string,
    files: { path: string; content: string; isModule?: boolean }[],
  ): Promise<void> {
    for (const { path, content, isModule } of files) {
      const rel = path.replace(/^\/+/, '');
      const fullPath = `/node_modules/${name}/${rel}`;
      await this.fs.writeFile(fullPath, content);
      if (isModule) {
        this.modules.set(fullPath, new Module(fullPath, content, false, this));
      }
    }
  }

  /**
   * Receive a host-pushed git-library mount and register it as a LOCAL module
   * under `/node_modules/<moduleName>/` (LIBRARY_MOUNTS_SPEC L3 / Q2 registration).
   * The host mounts a git-library repo's read-only fs at `mountPath` (`/mnt/<hash>`)
   * and tags the `mount-add` with `moduleName` (= the `dependencies` key); this
   * walks the mounted tree and feeds it to `addGitDependencyModule`, so the bundler
   * resolves the bare import from the mounted repo AHEAD of the CDN — no CDN fetch.
   * Called from `handleMountAdd` when an arrived mount carries `moduleName`, and
   * from `registerDeclaredGitLibraries()` at boot for a mount that already arrived.
   *
   * Idempotent-friendly: re-registering overwrites the same files
   * (`addGitDependencyModule` writes by path).
   *
   * Traversal safety: the relative paths are built only from `readdir` entry names
   * under `mountPath`; an entry named `.`/`..`, or containing `/`, `\`, or NUL, is
   * skipped (defense in depth), so a gathered rel path can never escape the package
   * root. Total files/bytes are capped and unreadable entries are skipped, so a
   * pathological tree degrades the one library rather than aborting boot.
   */
  async registerGitLibraryMount(moduleName: string, mountPath: string): Promise<void> {
    const fsp = this.fs.boundContext.fs.promises;
    const MODULE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
    const MAX_FILES = 5000;
    const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB — skip absurdly large trees

    const files: { path: string; content: string; isModule: boolean }[] = [];
    let totalBytes = 0;
    let capped = false;

    // Reject an entry name that could escape the package root or carry control
    // chars. `readdir` should never yield `/`-bearing names, but screen anyway.
    const isSafeName = (name: string): boolean => {
      if (name === '.' || name === '..') return false;
      if (name.includes('/') || name.includes('\\')) return false;
      if (name.includes('\0')) return false;
      return true;
    };

    const walk = async (absDir: string, relDir: string): Promise<void> => {
      if (capped) return;
      let entries: string[];
      try {
        entries = await fsp.readdir(absDir);
      } catch {
        return; // unreadable directory — skip, never abort the boot
      }
      for (const name of entries) {
        if (capped) return;
        if (!isSafeName(name)) continue; // defense in depth (see doc-comment)
        const abs = `${absDir}/${name}`;
        const rel = relDir ? `${relDir}/${name}` : name;
        let isDir: boolean;
        try {
          isDir = (await fsp.stat(abs)).isDirectory();
        } catch {
          continue; // vanished between readdir and stat — skip
        }
        if (isDir) {
          await walk(abs, rel);
          continue;
        }
        if (files.length >= MAX_FILES) {
          capped = true;
          return;
        }
        let content: string;
        try {
          content = await fsp.readFile(abs, 'utf8');
        } catch {
          continue; // unreadable file — skip rather than throw
        }
        totalBytes += content.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          capped = true;
          return;
        }
        const dot = name.lastIndexOf('.');
        const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
        files.push({ path: rel, content, isModule: MODULE_EXTS.has(ext) });
      }
    };

    await walk(mountPath, '');
    if (capped) {
      logger.warn(
        `Git-library '${moduleName}' at ${mountPath} exceeded the registration cap ` +
          `(${MAX_FILES} files / ${MAX_TOTAL_BYTES} bytes); registered a truncated subset.`,
      );
    }
    await this.addGitDependencyModule(moduleName, files);
  }

  /**
   * Boot step (LIBRARY_MOUNTS_SPEC L3): for every declared git-form dependency
   * (`gitDependencyNames`), if it is NOT already registered under
   * `/node_modules/<name>/package.json` (an arrived mount may have registered it
   * already via `handleMountAdd`), look up a mount whose `moduleName === name` in
   * the `MountService` and register it now. This makes boot deterministic for the
   * common host-push-before-compile case. No polling: a declared git lib with
   * neither a registered module nor a known mount logs a concise warning and is
   * left to fail resolution normally (a robust wait-for-arrival is a follow-up).
   *
   * Wired into `compile()` AFTER `processPackageJSON()` (deps known) and BEFORE
   * `loadNodeModules()` (CDN), guarded by `isFirstLoad`.
   */
  private async registerDeclaredGitLibraries(): Promise<void> {
    const names = gitDependencyNames(this.parsedPackageJSON?.dependencies);
    if (names.size === 0) return;
    const fsp = this.fs.boundContext.fs.promises;
    const mounts = this.mounts?.getMounts?.() ?? [];
    for (const name of names) {
      // Already registered (by an arrived mount or a prior pass)? Leave it.
      let alreadyRegistered = false;
      try {
        await fsp.stat(`/node_modules/${name}/package.json`);
        alreadyRegistered = true;
      } catch {
        /* not registered yet */
      }
      if (alreadyRegistered) continue;

      const descriptor = mounts.find((m) => m.moduleName === name);
      if (!descriptor) {
        logger.warn(
          `Git-library dependency '${name}' declared but no mount has arrived to ` +
            `register it; the import will resolve normally (likely fail). ` +
            `(LIBRARY_MOUNTS_SPEC L3 — wait-for-arrival is a follow-up.)`,
        );
        continue;
      }
      try {
        await this.registerGitLibraryMount(name, descriptor.path);
      } catch (e) {
        logger.warn(`Failed to register git-library '${name}' from ${descriptor.path}`, e);
      }
    }
  }

  /** Host-pinned SDK integrity (SDK_PACKAGING_SPEC §5.2), set from IInitConfig
   *  before the initial compile. Undefined → verification skipped (not wired). */
  setSdkIntegrity(integrity: SdkIntegrity | undefined): void {
    this.sdkIntegrity = integrity;
  }

  /** The §5.2 dirty set, set from IInitConfig before the initial compile.
   *  Undefined/empty → nothing dirty (every artifact eligible). */
  setDirtyPaths(paths: string[] | undefined): void {
    this.dirtyPaths = new Set(paths ?? []);
  }

  /** The out-of-band host-resolved package.json (BOOT_SCAFFOLDING_SPEC §3), set
   *  from IInitConfig before the initial compile. Undefined → the bundler reads
   *  `/app/package.json` from the filesystem as before (standalone fallback). */
  setConfigPackageJSON(pkg: IPackageJSON | undefined): void {
    this.configPackageJSON = pkg ?? null;
  }

  /** True if a repo-relative path is dirty (must not be seeded from artifacts). */
  isDirtyPath(repoRelPath: string): boolean {
    return this.dirtyPaths.has(repoRelPath);
  }

  /** Schedule §5.7 spot-verification at idle so it never competes with boot/input. */
  private scheduleSpotVerify(): void {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => void this.runSpotVerify());
    } else {
      setTimeout(() => void this.runSpotVerify(), 0);
    }
  }

  /**
   * Run §5.7 spot-verification: re-transpile a random sample of consumed artifacts
   * and byte-compare. On a mismatch, the store discards the whole section (live
   * transpile from here) and we report the verdict to the parent, which persists
   * the distrust mark for this `(coords, commitSha)` so later boots don't re-consume.
   */
  async runSpotVerify(): Promise<void> {
    // §5.7 byte check PLUS the §3 frontmatter extension: the sampled sources are
    // re-read anyway, so also re-derive their frontmatter and compare to the seeded
    // store — the only runtime path that can catch a forged/divergent sidecar (the
    // consult-HIT path never re-reads a covered `.mdx`; verify-on-read is dead).
    const verdict = await this.artifactStore.spotVerify(undefined, {
      frontmatterOf: (appPath) => this.lastMetadata.get(appPath),
    });
    if (!verdict.tampered) return;
    // §8.14 security event (logged here; the actionable channel is the message below).
    // The specific mismatch kind (§5.7 transpile byte-check vs §3 frontmatter) goes in
    // the log; the wire `reason` stays the stable `spot-verify-mismatch` the parent keys on.
    logger.warn(
      `Artifact spot-verify ${verdict.reason ?? 'mismatch'} at ${verdict.path} — all artifacts discarded for this session (UI_AS_APPS §8.14).`,
    );
    this.messageBus.sendMessage('artifact-distrust', {
      commitSha: this.artifactStore.getCommitSha(),
      reason: 'spot-verify-mismatch',
    });
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
    // [ir-perf:addlocal] sub-phase breakdown of SDK vendoring (the dominant
    // addLocalModules cost; LOAD_PROFILING_SPEC §2). Accumulated across modules.
    const timing: VendorTiming = { manifestMs: 0, filesMs: 0, fileCount: 0, verifyMs: 0, writeMs: 0 };
    for (const [moduleName, base] of Object.entries(SELF_HOST_BASES)) {
      // Fails closed (SelfHostResolutionError) on a below-floor or
      // non-concrete pin — surfaced as a boot error, never a silent
      // substitute (SDK_PACKAGING_SPEC §5.1).
      const version = resolveSelfHostVersion(
        raw,
        moduleName,
        DEFAULT_SDK_VERSION,
        SELF_HOST_FLOORS[moduleName] ?? '0.0.0',
      );
      const baseUrl = `${base.replace(/\/$/, '')}/v/${version}`;
      logger.debug(`Resolving ${moduleName}@${version} from self-host ${baseUrl}`);
      // SDK_PACKAGING_SPEC §5.2: a MISSING manifest entry for the resolved
      // version must fail closed, exactly like a hash mismatch — otherwise an
      // attacker who can influence the resolved version (or strip a version from
      // a tampered origin) sidesteps verification by landing on an unpinned one.
      // `decideIntegrity` enforces this only once the host has wired integrity;
      // with no host pin, verification is intentionally skipped (the guarantee
      // is inactive — see sdkIntegrity.ts module note), not failed.
      const decision = decideIntegrity(this.sdkIntegrity, moduleName, version);
      if (decision.action === 'fail-closed') {
        console.warn(`[security] sdk-integrity:missing-version ${moduleName}@${version}`);
        throw new SelfHostResolutionError(
          `${moduleName}@${version} has no host-pinned integrity entry. ` +
            `The host delivered an SDK integrity manifest but it does not cover the resolved version. ` +
            `(SDK_PACKAGING_SPEC §5.2: a missing manifest entry fails closed.)`,
        );
      }
      await this.vendorModuleFrom(
        moduleName,
        baseUrl,
        decision.action === 'verify' ? decision.hashes : undefined,
        timing,
      );
    }
    if (this.isFirstLoad) {
      // eslint-disable-next-line no-console
      console.info(
        `[ir-perf:addlocal] manifestFetch ${Math.round(timing.manifestMs)}ms · ` +
          `filesFetch(${timing.fileCount}) ${Math.round(timing.filesMs)}ms · ` +
          `verify ${Math.round(timing.verifyMs)}ms · writeRegister ${Math.round(timing.writeMs)}ms`,
      );
    }
  }

  /**
   * Names resolved from a self-hosted versioned location (those `addLocalModules`
   * registered as local modules). They must be removed from the dependency map
   * before the sandpack-CDN `/dep_tree/` query — otherwise an SDK version not yet
   * replicated npm→CDN would fail resolution for the whole app. Mirrors the CLI
   * lockset's `computeInputDepMap` stripping so the lockset echo-match still
   * holds. Self-hosting is implicit, so every `SELF_HOST_BASES` key is stripped.
   *
   * LIBRARY_MOUNTS_SPEC §2.1/§4 L2: also strip any dependency whose value is a
   * git-form specifier (`github:owner/repo#ref`, …). A git dep resolves from a
   * registered local module under `/node_modules/<name>/`
   * (`addGitDependencyModule`), NOT from the CDN — and `concreteVersion()` would
   * reject/mis-default a `github:` value if it reached the `/dep_tree/` query, so
   * it MUST be stripped here. (Runs in `loadNodeModules`, after
   * `processPackageJSON`, so `parsedPackageJSON` is available.)
   */
  private registryResolvedNames(): Set<string> {
    const names = new Set(Object.keys(SELF_HOST_BASES));
    for (const name of gitDependencyNames(this.parsedPackageJSON?.dependencies)) {
      names.add(name);
    }
    return names;
  }

  async preloadMDXMetadata(): Promise<void> {
    // Cached path (MDX_CONTENT_COLLECTIONS_SPEC §1.3): seed the store from the
    // frontmatter sidecar — a blob-SHA-confined JSON — instead of the recursive
    // walk + per-file read across the COW port. Clean covered files come from JSON;
    // modified `.mdx` (dirty set, parent-attested — no in-iframe walk) re-scan live;
    // an absent/rejected sidecar falls through to the full live walk below.
    const seed = await this.artifactStore.seedMdxMetadata({
      dirtySet: this.dirtyPaths,
      writableLayer: this.dirtyPaths,
    });
    if (seed.securityReject) {
      logger.warn(
        `MDX metadata sidecar rejected (${seed.securityReject}) — live-scanning frontmatter (UI_AS_APPS §8.14).`,
      );
      this.messageBus.sendMessage('artifact-distrust', {
        commitSha: this.artifactStore.getCommitSha(),
        reason: seed.securityReject,
      });
      // fall through to the live walk
    } else if (seed.present) {
      for (const [appPath, frontmatter] of seed.entries) this.seedMetadataEntry(appPath, frontmatter);
      // Modified `.mdx` re-scan live (cache==live under edits); the rest is covered.
      await Promise.all(
        [...this.dirtyPaths]
          .filter((relPath) => relPath.endsWith('.mdx'))
          .map(async (relPath) => {
            const appPath = underAppRoot(relPath);
            try {
              const source = await this.fs.readFileAsync(appPath);
              this.refreshMetadata(appPath, source);
            } catch {
              /* deleted/unreadable — no entry, matching a live scan */
            }
          }),
      );
      return;
    }

    const re = globToRegex('/**/*.mdx');
    const zenFsLayer = this.fs;
    const fsp = zenFsLayer.boundContext.fs.promises;

    // Walk `APP_ROOT` MANUALLY instead of with readdir's `{recursive:true}`.
    // `/app` is a port-backed COW mount (the parent-hosted working tree); ZenFS's
    // recursive walk descends by calling the MOUNTED fs directly per sub-entry,
    // which throws `ENOENT '/app'` across that mount boundary (single-path reads
    // like `/app/package.json` work — only the recursive enumeration breaks).
    // Resolving each absolute subpath through the vfs (the way file reads already
    // do) avoids it; a subdirectory that still can't be listed is skipped rather
    // than aborting the whole scan. Scope stays the repo (`APP_ROOT`) — dynamic
    // mounts (e.g. `/firestore`) and virtual node_modules aren't app-MDX sources.
    const mdxFiles: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        return; // unreadable directory — skip, never fail the scan
      }
      await Promise.all(names.map(async (name) => {
        const full = `${dir}/${name}`;
        let isDir: boolean;
        try {
          isDir = (await fsp.stat(full)).isDirectory();
        } catch {
          return; // vanished between readdir and stat — skip
        }
        if (isDir) await walk(full);
        else if (full.match(re)) mdxFiles.push(full);
      }));
    };
    await walk(APP_ROOT);

    await Promise.all(mdxFiles.map(async (filepath) => {
      try {
        const source = await zenFsLayer.readFileAsync(filepath);
        this.refreshMetadata(filepath, source);
      } catch {
        /* file vanished mid-scan — ignore (lazy refreshMetadata still covers it) */
      }
    }));
  }


  /**
   * Lazily extracts MDX frontmatter metadata when a file is (re-)read during
   * compilation. Fires `onMetadataChange` if the parsed metadata differs from
   * the last value observed for the same path.
   */
  /**
   * A synchronous view of the seeded MDX-frontmatter store for the SDK boot snapshot
   * (MDX_CONTENT_COLLECTIONS_SPEC §1.4). Keyed by the absolute `/app/...` module path
   * (`metadataKey.test.ts`). **Identity contract (load-bearing):** the VALUE objects
   * are the same references the `onMetadataChange` emitter fires (`lastMetadata` values,
   * never a clone), so the SDK's `DelayedEmitter` replay on `enable()` is a no-op via
   * `updateAlreadyApplied`'s reference short-circuit — a defensive clone would re-render
   * the whole collection after first paint (the CLS this feature removes; G-MDX-3
   * carries the zero-re-render-after-`enable()` test).
   */
  getMetadataSnapshot(): Record<string, Record<string, any>> {
    return Object.fromEntries(this.lastMetadata);
  }

  /**
   * Seed one entry from the frontmatter sidecar (§1.3) — sets the store to the
   * pre-parsed `frontmatter` and fires `onMetadataChange` with the SAME ref (the
   * identity contract above), without re-reading or re-parsing source.
   */
  private seedMetadataEntry(appPath: string, frontmatter: Record<string, any>): void {
    const prev = this.lastMetadata.get(appPath);
    if (prev && JSON.stringify(prev) === JSON.stringify(frontmatter)) return;
    this.lastMetadata.set(appPath, frontmatter);
    this.onMetadataChangeEmitter.fire({ type: 'metadata-update', update: { [appPath]: frontmatter } });
  }

  private refreshMetadata(path: string, source: string): void {
    const parsed = extractMetadata({ path, code: source });
    const next = parsed ? parsed.data : undefined;
    // Metadata is keyed by the file's ABSOLUTE module/fs path (e.g.
    // `/app/content/x.mdx`) — the same identifier `module.dynamicImport`, `fs`,
    // and the SDK `<Include>` use. Keeping the metadata key in the file space
    // (rather than stripping `APP_ROOT` into the URL space) means an app reads a
    // file's metadata and renders it with the SAME path; the URL layer owns the
    // `/files`↔`APP_ROOT` translation (FILES_PREFIX / underAppRoot).
    const prev = this.lastMetadata.get(path);

    const prevKey = prev ? JSON.stringify(prev) : undefined;
    const nextKey = next ? JSON.stringify(next) : undefined;
    if (prevKey === nextKey) {
      return;
    }

    if (next) {
      this.lastMetadata.set(path, next);
    } else {
      this.lastMetadata.delete(path);
    }
    this.onMetadataChangeEmitter.fire({
      type: 'metadata-update',
      update: { [path]: next ?? {} },
    });
  }

  /**
   * Returns the set of paths that changed since the last compile (as reported
   * by the zenfs watcher). Also invalidates the corresponding modules so the
   * transform queue re-reads them.
   */
  private collectChangedFiles(): string[] {
    return this.fs.drainPendingChanges();
  }

  async compile(): Promise<() => any> {
    if (!this.preset) {
      throw new BundlerError('Cannot compile before preset has been initialized');
    }

    // ir.sandbox.boot (R3-46, LOAD_PROFILING_SPEC §3 phase 3): the sandbox is
    // constructed + preset-initialized and the FIRST compile is beginning. This is
    // the earliest in-sandbox instant the bus is guaranteed live, so it brackets
    // "iframe create → ready" (ir.open → here) from the compile-prep + node-module
    // load that follows (here → ir.deps) — the stretch where cold boot spends most
    // of its time. Only on the first load; incremental recompiles are not boot.
    if (this.isFirstLoad) {
      emitPerfMarker(this.messageBus, 'ir.sandbox.boot');
    }

    // First-load boot sub-phase timing (R3-46 diagnostic): the ir.sandbox.boot→ir.deps
    // span is where cold boot spends most of its time, but it bundles several awaits
    // (module-mount setup, SDK vendoring, MDX scan, package.json parse, node-module
    // load). Lap each so the hot one is visible in the console on the next live run;
    // the /app source-read + transpile cost lives in the separate ir.deps→ir.transpile
    // span. Lapping is a no-op off the first load.
    const bootNow = (): number =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    const bootPhases: Array<[string, number]> = [];
    let bootLast = bootNow();
    const bootLap = (name: string): void => {
      if (!this.isFirstLoad) return;
      bootPhases.push([name, Math.round(bootNow() - bootLast)]);
      bootLast = bootNow();
    };

    // Ensure the bundler-owned mounts (`/node_modules`, `/transpiled`) exist before
    // the first read/write. Idempotent — `index.ts` already calls this after
    // construction; this guard covers the harness path (and any direct `compile()`).
    await this.setupModuleMounts();
    bootLap('setupModuleMounts');

    this.onStatusChangeEmitter.fire('installing-dependencies');

    // TODO: Have more fine-grained cache invalidation for the resolver
    // Reset resolver cache
    this.resolverCache = new Map();
    this.resolutionCache = new Map();
    this.cdnLayoutEligibility = new Map();
    this.cdnFastHits = 0;
    this.cdnFallThroughs = 0;
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
      bootLap('preloadModules');
      await this.addLocalModules();
      bootLap('addLocalModules');
      // Drain any spurious watcher events that fired during bootstrap so they
      // aren't interpreted as user-driven changes later.
      this.fs.drainPendingChanges();
      // Fire the app-root mount lifecycle (§11.3) — runs the MDX-metadata scan
      // (and any future post-mount actions). Replaces the former direct
      // preloadMDXMetadata() call; behaviour is unchanged (MDX is app-root-scoped).
      await this.runPostMount({ path: APP_ROOT, isAppRoot: true });
      bootLap('runPostMount');
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
      bootLap('processPackageJSON');

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

      // LIBRARY_MOUNTS_SPEC L3: register any declared git-library whose mount has
      // already arrived under `/node_modules/<name>/` BEFORE the CDN pass, so the
      // bare import resolves from the mounted repo (no CDN fetch). Best-effort.
      if (this.isFirstLoad) {
        await this.registerDeclaredGitLibraries();
        bootLap('registerDeclaredGitLibraries');
      }

      await this.loadNodeModules();
      bootLap('loadNodeModules');

      // R3-46 diagnostic: one console line breaking down the boot→deps span by
      // sub-phase, so the next live run shows which await dominates cold boot.
      if (this.isFirstLoad) {
        const total = bootPhases.reduce((sum, [, ms]) => sum + ms, 0);
        const breakdown = bootPhases.map(([n, ms]) => `${n} ${ms}ms`).join(' · ');
        // eslint-disable-next-line no-console
        console.info(`[ir-perf:boot] ${breakdown} → ir.deps (Σ ${total}ms)`);
        // R3-49d: CDN-layout fast-path coverage (fast hits skip resolveAsync;
        // fall-throughs ran the full resolver).
        // eslint-disable-next-line no-console
        console.info(`[ir-perf:cdn-resolve] fastHits ${this.cdnFastHits} · fallThroughs ${this.cdnFallThroughs}`);
      }

      // ir.deps (R3-46): node-module resolution finished. depCount is the declared
      // dependency count; the host orders marks by timestamp and derives the phase
      // duration from the surrounding marks.
      emitPerfMarker(this.messageBus, 'ir.deps', {
        depCount: Object.keys(this.parsedPackageJSON?.dependencies || {}).length,
      });
    }

    this.onStatusChangeEmitter.fire('transpiling');

    // Transform runtimes
    if (this.isFirstLoad) {
      for (const runtime of this.runtimes) {
        await this.transformModule(runtime);
        await this.moduleFinishedPromise(runtime);
      }
    }

    // §5.1 seed `/transpiled` from the cache zip's pre-transpiled artifacts before
    // entrypoint traversal, so covered sources are consulted (not transpiled)
    // below. Absent/invalid/stamp-mismatched artifacts are a no-op (live boot).
    if (this.isFirstLoad) {
      const seedResult = await this.artifactStore.seed({
        dirtySet: this.dirtyPaths,
        writableLayer: this.dirtyPaths,
      });
      if (seedResult.securityReject) {
        // §8.14: a seeding input was present in the writable layer — the whole
        // section is rejected (live transpile for everything this session).
        logger.warn(`Artifact seeding rejected (${seedResult.securityReject}); live transpiling.`);
      } else if (seedResult.seeded > 0) {
        logger.debug(`Seeded ${seedResult.seeded} pre-transpiled artifacts into /transpiled`);
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

    // DG-2 / decision #27: a default Vite scaffold parks global CSS (and
    // polyfills) in `src/main.tsx` — the local-dev render shim immediately.run
    // never executes (the render entry is the URL-selected `App.tsx`). Harvest
    // that file's *side-effect* imports and fold the resolved modules into the
    // graph so they're applied, WITHOUT running its `render()` call. First load
    // only; the modules then live in the graph and HMR like any other.
    if (this.isFirstLoad) {
      const { sideEffectModules } = await collectLocalEntrySideEffects({
        entryPoint: resolvedEntryPoint,
        resolve: (specifier, from) => this.resolveAsync(specifier, from),
        readFile: (path) => this.fs.readFileAsync(path),
        onWarn: (message, err) => {
          logger.debug(message);
          if (err) logger.debug(err);
        },
      });
      const applied: string[] = [];
      for (const path of sideEffectModules) {
        try {
          await this.transformModule(path);
          await this.moduleFinishedPromise(path);
          applied.push(path);
        } catch (err) {
          // A side-effect import that fails to compile degrades to the pre-#27
          // behaviour (not applied) rather than failing the whole compile.
          logger.error(`Failed compiling local-entry side-effect module ${path}`);
          logger.error(err);
        }
      }
      this.sideEffectModulePaths = applied;
    }

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

    // ir.transpile (R3-46): the babel transform pass is complete and the compiled
    // module graph has been forwarded. moduleCount is the size of that graph.
    emitPerfMarker(this.messageBus, 'ir.transpile', { moduleCount: this.modules.size });

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

        // Apply the local entry's side effects (CSS/polyfills — DG-2) before
        // the app renders. A failure here degrades the app (e.g. unstyled)
        // rather than crashing it, matching the pre-#27 behaviour.
        for (const path of this.sideEffectModulePaths) {
          const module = this.modules.get(path);
          if (!module) continue;
          try {
            module.evaluate();
          } catch (err) {
            logger.error(`Failed evaluating local-entry side-effect module ${path}`);
            logger.error(err);
          }
        }

        entryModule.evaluate();

        // ir.eval (R3-46): first-load module evaluation finished — the last
        // bundler phase before the app's own root render (the SDK then marks
        // ir.fmp/ir.interactive). moduleCount is the evaluated graph size. Marked
        // only on first load: the canonical request→interactive boot stream.
        emitPerfMarker(this.messageBus, 'ir.eval', { moduleCount: this.modules.size });

        this.isFirstLoad = false;
        // §5.7 mandatory spot-verification: on a boot that consumed artifacts,
        // verify a random sample at idle — never blocking boot or input handling.
        if (this.artifactStore.consumedCount() > 0) {
          this.scheduleSpotVerify();
        }
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
