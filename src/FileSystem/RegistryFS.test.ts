import { configure, mount, umount, fs } from '@zenfs/core';

import { ModuleRegistry } from '../bundler/module-registry';
import { NodeModule } from '../bundler/module-registry/NodeModule';
import { CDNModuleFileType } from '../bundler/module-registry/module-cdn';
import { RegistryFS, RegistryFileFetcher } from './RegistryFS';

/** Build a `ModuleRegistry`-shaped stub carrying only `modules` (all RegistryFS reads). */
function stubRegistry(modules: NodeModule[]): ModuleRegistry {
  const map = new Map<string, NodeModule>();
  for (const m of modules) map.set(m.name, m);
  return { modules: map } as unknown as ModuleRegistry;
}

const inlined = (content: string): CDNModuleFileType => ({ c: content, d: [], t: false });

/** A registry with one inlined file, one non-inlined (numeric) file, and a scoped module. */
function fixture(): { registry: ModuleRegistry; fetcher: jest.Mock } {
  const react = new NodeModule(
    'react',
    '18.3.1',
    {
      'index.js': inlined('module.exports = React;'),
      'package.json': inlined('{"name":"react"}'),
      'cjs/react.production.js': 1234, // listed-but-not-inlined → lazy fetch
    },
    [],
  );
  const babelRuntime = new NodeModule('@babel/runtime', '7.24.0', { 'helpers/esm/x.js': inlined('export const x = 1;') }, []);
  const fetcher = jest.fn<Promise<string>, [string, string, string]>(async () => 'FETCHED CONTENT');
  return { registry: stubRegistry([react, babelRuntime]), fetcher: fetcher as jest.Mock };
}

/** Mimic the VFS read sequence: stat for size, allocate, read, decode. */
async function readAll(regfs: RegistryFS, path: string): Promise<string> {
  const inode = await regfs.stat(path);
  const buffer = new Uint8Array(inode.size);
  await regfs.read(path, buffer, 0, inode.size);
  return new TextDecoder().decode(buffer);
}

describe('RegistryFS (direct backend)', () => {
  describe('stat', () => {
    it('reports an inlined file as a regular file with exact byte size', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      const inode = await regfs.stat('/react/index.js');
      expect((inode.mode & 0o170000) === 0o100000).toBe(true); // S_IFREG
      expect(inode.size).toBe(new TextEncoder().encode('module.exports = React;').length);
      expect(fetcher).not.toHaveBeenCalled(); // inlined → no fetch
    });

    it('reports module root, scope, and fs root as directories', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      for (const dir of ['/', '/react', '/@babel', '/@babel/runtime', '/react/cjs']) {
        const inode = await regfs.stat(dir);
        expect((inode.mode & 0o170000) === 0o040000).toBe(true); // S_IFDIR
      }
    });

    it('throws ENOENT for a missing module or file', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      await expect(regfs.stat('/does-not-exist')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(regfs.stat('/react/nope.js')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('read', () => {
    it('returns inlined content without fetching', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      expect(await readAll(regfs, '/react/index.js')).toBe('module.exports = React;');
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('lazily fetches a non-inlined file exactly once, then serves from cache', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      expect(await readAll(regfs, '/react/cjs/react.production.js')).toBe('FETCHED CONTENT');
      expect(await readAll(regfs, '/react/cjs/react.production.js')).toBe('FETCHED CONTENT');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith('react', '18.3.1', 'cjs/react.production.js');
    });

    it('dedupes concurrent fetches of the same non-inlined file', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      const [a, b] = await Promise.all([
        readAll(regfs, '/react/cjs/react.production.js'),
        readAll(regfs, '/react/cjs/react.production.js'),
      ]);
      expect(a).toBe('FETCHED CONTENT');
      expect(b).toBe('FETCHED CONTENT');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('readdir', () => {
    it('lists top-level modules and @scope dirs (deduped) at the root', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      expect((await regfs.readdir('/')).sort()).toEqual(['@babel', 'react']);
    });

    it('lists a module root with directories collapsed', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      expect((await regfs.readdir('/react')).sort()).toEqual(['cjs', 'index.js', 'package.json']);
    });

    it('lists the second segment of modules under a scope', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      expect(await regfs.readdir('/@babel')).toEqual(['runtime']);
    });

    it('reflects a module added to the registry AFTER construction (live, not snapshot)', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      expect((await regfs.readdir('/')).includes('lodash')).toBe(false);
      registry.modules.set('lodash', new NodeModule('lodash', '4.17.21', { 'index.js': inlined('') }, []));
      expect((await regfs.readdir('/')).includes('lodash')).toBe(true);
    });
  });

  describe('exists', () => {
    it('answers from the registry without fetching', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      expect(await regfs.exists('/react/index.js')).toBe(true);
      expect(await regfs.exists('/react/cjs/react.production.js')).toBe(true); // non-inlined
      expect(await regfs.exists('/react')).toBe(true);
      expect(await regfs.exists('/nope')).toBe(false);
      expect(fetcher).not.toHaveBeenCalled(); // existence never triggers a fetch
    });
  });

  describe('read-only: every write method rejects with EROFS', () => {
    it('rejects async write methods', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      const opts = { uid: 0, gid: 0, mode: 0o644 };
      await expect(regfs.write('/react/index.js', new Uint8Array(), 0)).rejects.toMatchObject({ code: 'EROFS' });
      await expect(regfs.createFile('/react/new.js', opts)).rejects.toMatchObject({ code: 'EROFS' });
      await expect(regfs.mkdir('/react/newdir', opts)).rejects.toMatchObject({ code: 'EROFS' });
      await expect(regfs.unlink('/react/index.js')).rejects.toMatchObject({ code: 'EROFS' });
      await expect(regfs.rmdir('/react')).rejects.toMatchObject({ code: 'EROFS' });
      await expect(regfs.rename('/react/index.js', '/react/other.js')).rejects.toMatchObject({ code: 'EROFS' });
      await expect(regfs.link('/react/index.js', '/react/link.js')).rejects.toMatchObject({ code: 'EROFS' });
    });

    it('treats touch (atime bookkeeping) as a no-op, not EROFS, so reads can close', async () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      // touch cannot change content or structure; the zenfs VFS calls it on read-close.
      await expect(regfs.touch('/react/index.js', {})).resolves.toBeUndefined();
      expect(() => regfs.touchSync('/react/index.js', {})).not.toThrow();
    });

    it('rejects sync write methods', () => {
      const { registry, fetcher } = fixture();
      const regfs = new RegistryFS(registry, fetcher as unknown as RegistryFileFetcher);
      const opts = { uid: 0, gid: 0, mode: 0o644 };
      expect(() => regfs.writeSync('/react/index.js', new Uint8Array(), 0)).toThrow();
      expect(() => regfs.createFileSync('/react/new.js', opts)).toThrow();
      expect(() => regfs.mkdirSync('/react/newdir', opts)).toThrow();
      expect(() => regfs.unlinkSync('/react/index.js')).toThrow();
    });
  });
});

describe('RegistryFS (mounted in a real ZenFS VFS)', () => {
  let fetcher: jest.Mock;

  beforeEach(async () => {
    await configure({ disableAccessChecks: true });
    const fx = fixture();
    fetcher = fx.fetcher;
    await fs.promises.mkdir('/node_modules').catch(() => undefined); // materialize mount point
    mount('/node_modules', new RegistryFS(fx.registry, fetcher as unknown as RegistryFileFetcher));
  });

  afterEach(() => {
    try {
      umount('/node_modules');
    } catch {
      /* not mounted */
    }
  });

  it('reads an inlined file through fs.promises', async () => {
    expect(await fs.promises.readFile('/node_modules/react/index.js', 'utf8')).toBe('module.exports = React;');
  });

  it('reads a non-inlined file through fs.promises (lazy fetch)', async () => {
    expect(await fs.promises.readFile('/node_modules/react/cjs/react.production.js', 'utf8')).toBe('FETCHED CONTENT');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('lists a module directory through fs.promises.readdir', async () => {
    expect((await fs.promises.readdir('/node_modules/react')).sort()).toEqual(['cjs', 'index.js', 'package.json']);
  });

  it('stat distinguishes files from directories through the VFS', async () => {
    expect((await fs.promises.stat('/node_modules/react/index.js')).isFile()).toBe(true);
    expect((await fs.promises.stat('/node_modules/react')).isDirectory()).toBe(true);
  });

  it('rejects an overwrite of an existing dependency file with EROFS', async () => {
    await expect(fs.promises.writeFile('/node_modules/react/index.js', 'hacked')).rejects.toMatchObject({ code: 'EROFS' });
  });

  it('rejects NEW-file creation under the mount with EROFS (not a silent drop)', async () => {
    await expect(fs.promises.writeFile('/node_modules/react/evil.js', 'evil')).rejects.toMatchObject({ code: 'EROFS' });
    // the rejection is real: the file never came into existence
    expect(await fs.promises.readFile('/node_modules/react/evil.js', 'utf8').then(() => 'exists').catch(() => 'absent')).toBe(
      'absent',
    );
  });
});
