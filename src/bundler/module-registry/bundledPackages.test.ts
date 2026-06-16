/**
 * @jest-environment jsdom
 *
 * R3-49a consume side: the ModuleRegistry reads zip-bundled `/package/` content from
 * the mounted FS instead of fetching the CDN, and falls back to a live fetch when a
 * package isn't bundled / the bundle is absent or corrupt. (jsdom: importing
 * ModuleRegistry transitively loads the evaluation runtime, which touches `window`.)
 */
import { encode as encodeMsgPack } from '@msgpack/msgpack';

import { ModuleRegistry } from '.';
import { Bundler } from '../bundler';
import { fetchModule } from './module-cdn';
import { parseBundledIndex, decodeBundledModule } from './bundledPackages';

jest.mock('./module-cdn', () => ({
  ...jest.requireActual('./module-cdn'),
  fetchManifest: jest.fn(),
  fetchModule: jest.fn(),
}));

const mockedFetchModule = fetchModule as jest.MockedFunction<typeof fetchModule>;

const MODULE = { f: { 'index.js': { c: 'module.exports = "bundled"', d: [], t: false } }, m: [] };
const CDN_MODULE = { f: { 'index.js': { c: 'module.exports = "cdn"', d: [], t: false } }, m: [] };

const indexJson = (entries: Array<{ n: string; v: string; path: string }>) =>
  JSON.stringify({ cdnVersion: 5, packages: entries.map((e) => ({ ...e, key: `k:${e.n}` })) });

// Minimal Bundler stand-in exposing only the FS reads the consume path uses.
const makeBundler = (opts: {
  index?: string | Error;
  bytes?: Record<string, Uint8Array>;
}): Bundler =>
  ({
    fs: {
      readFileAsync: async () => {
        if (opts.index === undefined) throw new Error('no index');
        if (opts.index instanceof Error) throw opts.index;
        return opts.index;
      },
      readBytesAsync: async (p: string) => {
        const hit = Object.entries(opts.bytes ?? {}).find(([name]) => p.endsWith(name));
        if (!hit) throw new Error(`not bundled: ${p}`);
        return hit[1];
      },
    },
    modules: new Map(),
  }) as unknown as Bundler;

beforeEach(() => {
  mockedFetchModule.mockReset();
  mockedFetchModule.mockResolvedValue(CDN_MODULE as never);
});

describe('parseBundledIndex', () => {
  it('maps name@version → in-zip path', () => {
    const map = parseBundledIndex(indexJson([{ n: 'react', v: '18.3.1', path: 'react.msgpack' }]));
    expect(map?.get('react@18.3.1')).toBe('react.msgpack');
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['no packages array', JSON.stringify({ cdnVersion: 5 })],
  ])('returns null for %s', (_label, raw) => {
    expect(parseBundledIndex(raw)).toBeNull();
  });

  it('skips entries missing required fields', () => {
    const map = parseBundledIndex(
      JSON.stringify({ packages: [{ n: 'ok', v: '1.0.0', path: 'ok.msgpack' }, { n: 'bad' }] }),
    );
    expect(map?.size).toBe(1);
    expect(map?.get('ok@1.0.0')).toBe('ok.msgpack');
  });
});

describe('decodeBundledModule', () => {
  it('round-trips verbatim /package/ msgpack into an ICDNModule', () => {
    expect(decodeBundledModule(encodeMsgPack(MODULE))).toEqual(MODULE);
  });
});

describe('ModuleRegistry bundled-package consumption', () => {
  it('reads a bundled package from the zip and does NOT fetch the CDN', async () => {
    const reg = new ModuleRegistry(
      makeBundler({
        index: indexJson([{ n: 'react', v: '18.3.1', path: 'react.msgpack' }]),
        bytes: { 'react.msgpack': encodeMsgPack(MODULE) },
      }),
    );
    const mod = await reg.fetchNodeModule('react', '18.3.1');
    expect(mod.files['index.js']).toEqual(MODULE.f['index.js']);
    expect(mockedFetchModule).not.toHaveBeenCalled();
  });

  it('falls back to the CDN when the package is not bundled', async () => {
    const reg = new ModuleRegistry(
      makeBundler({ index: indexJson([{ n: 'react', v: '18.3.1', path: 'react.msgpack' }]) }),
    );
    const mod = await reg.fetchNodeModule('lodash', '4.17.21'); // not in the index
    expect(mockedFetchModule).toHaveBeenCalledWith('lodash', '4.17.21');
    expect(mod.files['index.js']).toEqual(CDN_MODULE.f['index.js']);
  });

  it('falls back to the CDN when there is no bundle index at all', async () => {
    const reg = new ModuleRegistry(makeBundler({})); // readFileAsync throws
    await reg.fetchNodeModule('react', '18.3.1');
    expect(mockedFetchModule).toHaveBeenCalledWith('react', '18.3.1');
  });

  it('falls back to the CDN when a bundled package fails to read/decode', async () => {
    const reg = new ModuleRegistry(
      makeBundler({
        index: indexJson([{ n: 'react', v: '18.3.1', path: 'react.msgpack' }]),
        bytes: { 'react.msgpack': new Uint8Array([0xff, 0xff, 0xff]) }, // not valid msgpack
      }),
    );
    await reg.fetchNodeModule('react', '18.3.1');
    expect(mockedFetchModule).toHaveBeenCalledWith('react', '18.3.1');
  });
});
