import { configure, fs } from '@zenfs/core';
import { bindContext } from '@zenfs/core';

import { withReadOnlyMounts } from './readOnlyMounts';

const OPTS = { readOnlyPrefixes: ['/node_modules', '/transpiled'], pwd: '/app' };

/**
 * A fresh ZenFS with WRITABLE `/app`, `/node_modules`, `/transpiled` (all
 * InMemory) so a write that is NOT guarded would succeed — proving the guard,
 * not a read-only backend, is what rejects.
 */
async function setup(): Promise<ReturnType<typeof withReadOnlyMounts>> {
  await configure({ disableAccessChecks: true });
  await fs.promises.mkdir('/app', { recursive: true });
  await fs.promises.mkdir('/node_modules/react', { recursive: true });
  await fs.promises.mkdir('/transpiled', { recursive: true });
  // Seed an existing dependency file via the UNGUARDED fs.
  await fs.promises.writeFile('/node_modules/react/index.js', 'module.exports = React;');

  const bound = bindContext({ root: '/', pwd: '/app' }).fs;
  return withReadOnlyMounts(bound as unknown as object, OPTS) as typeof fs;
}

describe('withReadOnlyMounts', () => {
  let guarded: typeof fs;

  beforeEach(async () => {
    guarded = (await setup()) as typeof fs;
  });

  describe('async (promises) writes under a read-only prefix → EROFS', () => {
    it('rejects overwriting an existing dependency file', async () => {
      await expect(guarded.promises.writeFile('/node_modules/react/index.js', 'hacked')).rejects.toMatchObject({
        code: 'EROFS',
      });
      // unchanged
      expect(await guarded.promises.readFile('/node_modules/react/index.js', 'utf8')).toBe('module.exports = React;');
    });

    it('rejects NEW-file creation (the leak a read-only credential would allow)', async () => {
      await expect(guarded.promises.writeFile('/node_modules/react/evil.js', 'evil')).rejects.toMatchObject({
        code: 'EROFS',
      });
      // the rejection is real — the file never came into existence
      await expect(guarded.promises.readFile('/node_modules/react/evil.js', 'utf8')).rejects.toBeDefined();
    });

    it('rejects mkdir under the prefix', async () => {
      await expect(guarded.promises.mkdir('/node_modules/newpkg')).rejects.toMatchObject({ code: 'EROFS' });
    });

    it('rejects a write under /transpiled', async () => {
      await expect(guarded.promises.writeFile('/transpiled/App.tsx.js', 'x')).rejects.toMatchObject({ code: 'EROFS' });
    });

    it('rejects unlink and rename touching the prefix', async () => {
      await expect(guarded.promises.unlink('/node_modules/react/index.js')).rejects.toMatchObject({ code: 'EROFS' });
      await fs.promises.writeFile('/app/data.json', '{}'); // a real app file (unguarded seed)
      await expect(guarded.promises.rename('/app/data.json', '/node_modules/react/data.json')).rejects.toMatchObject({
        code: 'EROFS',
      });
    });

    it('catches a relative-path escape (../node_modules) resolved against pwd', async () => {
      await expect(guarded.promises.writeFile('../node_modules/react/sneak.js', 'x')).rejects.toMatchObject({
        code: 'EROFS',
      });
    });

    it('blocks open() with write flags but allows read-only open()', async () => {
      await expect(guarded.promises.open('/node_modules/react/index.js', 'w')).rejects.toMatchObject({ code: 'EROFS' });
      const handle = await guarded.promises.open('/node_modules/react/index.js', 'r');
      await handle.close();
    });
  });

  describe('writes OUTSIDE the prefixes pass through', () => {
    it('allows writing under /app', async () => {
      await guarded.promises.writeFile('/app/notes.txt', 'hello');
      expect(await guarded.promises.readFile('/app/notes.txt', 'utf8')).toBe('hello');
    });

    it('allows mkdir under /app', async () => {
      await guarded.promises.mkdir('/app/sub');
      expect((await guarded.promises.stat('/app/sub')).isDirectory()).toBe(true);
    });
  });

  describe('reads under a read-only prefix pass through', () => {
    it('reads a dependency file', async () => {
      expect(await guarded.promises.readFile('/node_modules/react/index.js', 'utf8')).toBe('module.exports = React;');
    });

    it('lists a read-only directory', async () => {
      expect(await guarded.promises.readdir('/node_modules/react')).toContain('index.js');
    });
  });

  describe('sync and callback forms', () => {
    it('throws EROFS from a sync write under the prefix', () => {
      expect(() => guarded.writeFileSync('/node_modules/react/sync.js', 'x')).toThrow(
        expect.objectContaining({ code: 'EROFS' }),
      );
    });

    it('allows a sync write under /app', () => {
      guarded.writeFileSync('/app/sync.txt', 'ok');
      expect(guarded.readFileSync('/app/sync.txt', 'utf8')).toBe('ok');
    });

    it('delivers EROFS to a callback-form write under the prefix', (done) => {
      guarded.writeFile('/node_modules/react/cb.js', 'x', (err: NodeJS.ErrnoException | null) => {
        try {
          expect(err).toMatchObject({ code: 'EROFS' });
          done();
        } catch (e) {
          done(e as Error);
        }
      });
    });
  });
});
