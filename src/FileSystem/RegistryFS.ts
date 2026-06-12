import { FileSystem, type CreationOptions, type InodeLike } from '@zenfs/core';
import { withErrno } from 'kerium';

import { ModuleRegistry } from '../bundler/module-registry';
import { retryFetch, registerImmutableUrlPrefix } from '../utils/fetch';

// POSIX mode type bits (not re-exported from @zenfs/core's entrypoint, so
// defined locally to avoid depending on an internal path).
const S_IFREG = 0o100000; // regular file
const S_IFDIR = 0o040000; // directory
const READ_ONLY_FILE = S_IFREG | 0o444;
const READ_ONLY_DIR = S_IFDIR | 0o555;

// Files are always requested at an exact version (the registry resolves it), so
// the responses are immutable and `retryFetch` serves them cache-first from the
// persistent immutable cache — forwarded to the parent in the opaque-origin
// iframe (PRETRANSPILED_ARTIFACTS_SPEC §3.5). Mirrors `NodeModuleFSLayer`.
registerImmutableUrlPrefix('https://unpkg.com/');

/** Default lazy fetch for a file the CDN bundle lists but does not inline. */
const defaultFetchFile = async (moduleName: string, moduleVersion: string, relPath: string): Promise<string> => {
  const response = await retryFetch(`https://unpkg.com/${moduleName}@${moduleVersion}/${relPath}`, { maxRetries: 5 });
  return response.text();
};

export type RegistryFileFetcher = (moduleName: string, moduleVersion: string, relPath: string) => Promise<string>;

interface ParsedPath {
  /** Bare module name (`react`, `@babel/runtime`), or null for the FS root. */
  moduleName: string | null;
  /** Path within the module, no leading slash (`index.js`, `lib/foo.js`, ''). */
  relPath: string;
  /** A scope segment (`@babel`) addressed on its own, e.g. `/@babel`. */
  scopeOnly: string | null;
}

/**
 * Read-only ZenFS backend over a {@link ModuleRegistry}. Replaces the
 * `NodeModuleFSLayer` of the retired layered union (PRETRANSPILED_ARTIFACTS_SPEC
 * §3.1, Gate 0): mounted at `/node_modules`, it answers metadata **live** from
 * the registry's per-module file maps (the registry grows as dependencies
 * resolve, so reads must consult it at call time, not a snapshot) and lazily
 * fetches a listed-but-not-inlined file from unpkg through `retryFetch`.
 *
 * Every write method throws `EROFS` (explicit rejection — the writable side of
 * the COW mount absorbs writes; a credential/`no_write`-based read-only would
 * silently DROP writes and leak new-file creation, which §5.7 forbids).
 *
 * Paths arrive **mount-relative** (leading slash, e.g. `/react/index.js`).
 */
export class RegistryFS extends FileSystem {
  private contentCache: Map<string, string> = new Map();
  private inflight: Map<string, Promise<string>> = new Map();
  private inoByPath: Map<string, number> = new Map();
  private nextIno = 1;

  constructor(
    private registry: ModuleRegistry,
    private fetchFile: RegistryFileFetcher = defaultFetchFile,
  ) {
    // 0x52454753 = "REGS"; the name surfaces in zenfs diagnostics.
    super(0x52454753, 'registryfs');
  }

  // --- path parsing -------------------------------------------------------

  private parsePath(path: string): ParsedPath {
    const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (trimmed === '') {
      return { moduleName: null, relPath: '', scopeOnly: null };
    }
    const segments = trimmed.split('/');
    if (segments[0].startsWith('@')) {
      if (segments.length === 1) {
        // `/@scope` on its own — a scope namespace directory.
        return { moduleName: null, relPath: '', scopeOnly: segments[0] };
      }
      return { moduleName: `${segments[0]}/${segments[1]}`, relPath: segments.slice(2).join('/'), scopeOnly: null };
    }
    return { moduleName: segments[0], relPath: segments.slice(1).join('/'), scopeOnly: null };
  }

  private ino(path: string): number {
    let ino = this.inoByPath.get(path);
    if (ino === undefined) {
      ino = this.nextIno++;
      this.inoByPath.set(path, ino);
    }
    return ino;
  }

  private makeInode(path: string, mode: number, size: number): InodeLike {
    const now = Date.now();
    return {
      ino: this.ino(path),
      size,
      mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
    };
  }

  // --- registry-backed classification (no fetch) --------------------------

  /** True if `relPath` is a strict directory prefix of any file in the module. */
  private isDirPrefix(module: { files: Record<string, unknown> }, relPath: string): boolean {
    const prefix = relPath === '' ? '' : `${relPath}/`;
    for (const key of Object.keys(module.files)) {
      if (relPath === '' || key.startsWith(prefix)) {
        if (relPath === '' ? key.length > 0 : key.length > prefix.length) return true;
      }
    }
    return false;
  }

  /** Does any registered module live under this `@scope`? */
  private scopeHasModules(scope: string): boolean {
    const prefix = `${scope}/`;
    for (const name of this.registry.modules.keys()) {
      if (name.startsWith(prefix)) return true;
    }
    return false;
  }

  private classify(path: string): 'file' | 'dir' | 'missing' {
    const { moduleName, relPath, scopeOnly } = this.parsePath(path);
    if (moduleName === null && scopeOnly === null) return 'dir'; // root
    if (scopeOnly !== null) return this.scopeHasModules(scopeOnly) ? 'dir' : 'missing';

    const module = this.registry.modules.get(moduleName!);
    if (!module) return 'missing';
    if (relPath === '') return 'dir'; // module root
    if (module.files[relPath] != null) return 'file';
    if (this.isDirPrefix(module, relPath)) return 'dir';
    return 'missing';
  }

  // --- content (lazy fetch + cache) ---------------------------------------

  private async getContent(path: string): Promise<string> {
    const cached = this.contentCache.get(path);
    if (cached !== undefined) return cached;

    const { moduleName, relPath } = this.parsePath(path);
    const module = moduleName ? this.registry.modules.get(moduleName) : undefined;
    const file = module?.files[relPath];
    if (module === undefined || file == null) {
      throw withErrno('ENOENT');
    }

    // Inlined content (`{ c, d, t }`); a number means listed-but-not-inlined.
    if (typeof file === 'object') {
      this.contentCache.set(path, file.c);
      return file.c;
    }

    let promise = this.inflight.get(path);
    if (!promise) {
      promise = this.fetchFile(moduleName!, module.version, relPath)
        .then((content) => {
          this.contentCache.set(path, content);
          return content;
        })
        .finally(() => this.inflight.delete(path));
      this.inflight.set(path, promise);
    }
    return promise;
  }

  private cachedSize(path: string, file: object | number): number {
    const cached = this.contentCache.get(path);
    if (cached !== undefined) return byteLength(cached);
    if (typeof file === 'object') return byteLength((file as { c: string }).c);
    return file; // a numeric entry is the file's byte size (sandpack-cdn convention)
  }

  // --- FileSystem: metadata -----------------------------------------------

  async stat(path: string): Promise<InodeLike> {
    const kind = this.classify(path);
    if (kind === 'missing') throw withErrno('ENOENT');
    if (kind === 'dir') return this.makeInode(path, READ_ONLY_DIR, 0);
    // A file: fetch+cache so the reported size is exact (zenfs reads up to size).
    const content = await this.getContent(path);
    this.contentCache.set(path, content);
    return this.makeInode(path, READ_ONLY_FILE, byteLength(content));
  }

  statSync(path: string): InodeLike {
    const kind = this.classify(path);
    if (kind === 'missing') throw withErrno('ENOENT');
    if (kind === 'dir') return this.makeInode(path, READ_ONLY_DIR, 0);
    const { moduleName, relPath } = this.parsePath(path);
    const file = this.registry.modules.get(moduleName!)!.files[relPath]!;
    return this.makeInode(path, READ_ONLY_FILE, this.cachedSize(path, file));
  }

  async exists(path: string): Promise<boolean> {
    return this.classify(path) !== 'missing';
  }

  existsSync(path: string): boolean {
    return this.classify(path) !== 'missing';
  }

  async readdir(path: string): Promise<string[]> {
    return this.readdirSync(path);
  }

  readdirSync(path: string): string[] {
    const kind = this.classify(path);
    if (kind === 'missing') throw withErrno('ENOENT');
    if (kind === 'file') throw withErrno('ENOTDIR');

    const { moduleName, relPath, scopeOnly } = this.parsePath(path);

    if (moduleName === null && scopeOnly === null) {
      // Root: top-level names — bare modules + `@scope` directories, deduped.
      const names = new Set<string>();
      for (const name of this.registry.modules.keys()) {
        names.add(name.startsWith('@') ? name.split('/')[0] : name);
      }
      return [...names];
    }

    if (scopeOnly !== null) {
      // `/@scope` → the second segment of each `@scope/*` module.
      const names = new Set<string>();
      const prefix = `${scopeOnly}/`;
      for (const name of this.registry.modules.keys()) {
        if (name.startsWith(prefix)) names.add(name.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    }

    // Inside a module: immediate children of `relPath` over the flat file map.
    const module = this.registry.modules.get(moduleName!)!;
    const dirPrefix = relPath === '' ? '' : `${relPath}/`;
    const children = new Set<string>();
    for (const key of Object.keys(module.files)) {
      if (!key.startsWith(dirPrefix)) continue;
      const next = key.slice(dirPrefix.length).split('/')[0];
      if (next) children.add(next);
    }
    return [...children];
  }

  // --- FileSystem: reads --------------------------------------------------

  async read(path: string, buffer: Uint8Array, offset = 0, end?: number): Promise<void> {
    const content = await this.getContent(path);
    copyInto(buffer, content, offset, end);
  }

  readSync(path: string, buffer: Uint8Array, offset = 0, end?: number): void {
    const cached = this.contentCache.get(path);
    if (cached === undefined) {
      // Async-only backend: a non-inlined file not yet cached can't be served
      // synchronously. Kick the async fetch so a retry succeeds (mirrors
      // FetchFS.readSync). The sandbox reads via `fs.promises.*` only.
      void this.getContent(path).catch(() => undefined);
      throw withErrno('EAGAIN');
    }
    copyInto(buffer, cached, offset, end);
  }

  // --- FileSystem: writes — all rejected with EROFS (spec §5.7) ------------

  rename(_oldPath: string, _newPath: string): Promise<void> {
    return Promise.reject(withErrno('EROFS'));
  }
  renameSync(_oldPath: string, _newPath: string): void {
    throw withErrno('EROFS');
  }
  // `touch` (atime/mtime bookkeeping) is a NO-OP, not EROFS: the zenfs VFS calls
  // it when closing a handle after a *normal read*, so rejecting it would break
  // reads (and mask real write errors with a SuppressedError on disposal).
  // Timestamps are meaningless for a registry-backed FS; immutability is enforced
  // by rejecting the content/structure mutations below.
  touch(_path: string, _metadata: Partial<InodeLike>): Promise<void> {
    return Promise.resolve();
  }
  touchSync(_path: string, _metadata: Partial<InodeLike>): void {
    return;
  }
  createFile(_path: string, _options: CreationOptions): Promise<InodeLike> {
    return Promise.reject(withErrno('EROFS'));
  }
  createFileSync(_path: string, _options: CreationOptions): InodeLike {
    throw withErrno('EROFS');
  }
  unlink(_path: string): Promise<void> {
    return Promise.reject(withErrno('EROFS'));
  }
  unlinkSync(_path: string): void {
    throw withErrno('EROFS');
  }
  rmdir(_path: string): Promise<void> {
    return Promise.reject(withErrno('EROFS'));
  }
  rmdirSync(_path: string): void {
    throw withErrno('EROFS');
  }
  mkdir(_path: string, _options: CreationOptions): Promise<InodeLike> {
    return Promise.reject(withErrno('EROFS'));
  }
  mkdirSync(_path: string, _options: CreationOptions): InodeLike {
    throw withErrno('EROFS');
  }
  link(_target: string, _link: string): Promise<void> {
    return Promise.reject(withErrno('EROFS'));
  }
  linkSync(_target: string, _link: string): void {
    throw withErrno('EROFS');
  }
  write(_path: string, _buffer: Uint8Array, _offset: number): Promise<void> {
    return Promise.reject(withErrno('EROFS'));
  }
  writeSync(_path: string, _buffer: Uint8Array, _offset: number): void {
    throw withErrno('EROFS');
  }

  // --- FileSystem: sync barrier (nothing to flush) ------------------------

  sync(): Promise<void> {
    return Promise.resolve();
  }
  syncSync(): void {
    return;
  }
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
function byteLength(content: string): number {
  return encoder.encode(content).length;
}

/** Encode `content` and copy the `[offset, end)` byte slice into `buffer`. */
function copyInto(buffer: Uint8Array, content: string, offset: number, end?: number): void {
  const bytes = encoder.encode(content);
  const stop = end === undefined ? bytes.length : Math.min(end, bytes.length);
  if (stop <= offset) return;
  buffer.set(bytes.subarray(offset, stop));
}
