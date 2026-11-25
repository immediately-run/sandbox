/**
 * esm.sh fallback source helpers (esm-fallback.ts): entry-URL construction,
 * re-export-stub following, specifier classification, and module synthesis.
 * The ModuleRegistry wiring that consumes these (index.ts) is tested in
 * index.test.ts.
 */
import {
  EsmFallbackFetcher,
  esmFallbackEntryUrl,
  fetchEsmFallbackSource,
  importedSpecifiers,
  isEsmInternal,
  nativeEsmFallbackSubpathLoader,
  parseBareSubpath,
  parseReexportStub,
  synthesizeEsmFallbackModule,
} from './esm-fallback';
import { ICDNModuleFile } from './module-cdn';
import { retryFetch } from '../../utils/fetch';

jest.mock('../../utils/fetch', () => ({ retryFetch: jest.fn() }));
const mockedRetryFetch = retryFetch as jest.MockedFunction<typeof retryFetch>;

const jsonResponse = (body: string, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response);

// A stand-in for the esm.sh `.mjs`: bare `import ... from "react"` + real code, so
// the transpile yields `require("react")` resolved by the bundler to the app React.
const LUCIDE_MJS = [
  'import { createElement, forwardRef, useContext, createContext } from "react";',
  'const IconContext = createContext({});',
  'export const Search = forwardRef((p, ref) => { useContext(IconContext); return createElement("svg", { ...p, ref }); });',
  'export const Camera = forwardRef((p, ref) => createElement("svg", { ...p, ref }));',
].join('\n');

describe('esm.sh source helpers', () => {
  it('esmFallbackEntryUrl externalizes the resolved deps (sorted) and pins target', () => {
    expect(esmFallbackEntryUrl('lucide-react', '^1.21.0', ['react-dom', 'react'])).toBe(
      'https://esm.sh/lucide-react@^1.21.0?external=react,react-dom&target=es2022',
    );
  });

  it('isEsmInternal: esm.sh-internal vs bare specifiers', () => {
    expect(isEsmInternal('/lucide-react@1.21.0/es2022/lucide-react.mjs')).toBe(true);
    expect(isEsmInternal('https://esm.sh/x.mjs')).toBe(true);
    expect(isEsmInternal('react')).toBe(false);
    expect(isEsmInternal('react-dom/client')).toBe(false);
  });

  it('importedSpecifiers collects static + dynamic specifiers', () => {
    const src = 'import a from "react";\nexport * from "/chunk.mjs";\nconst x = import("./y.mjs");';
    expect(importedSpecifiers(src).sort()).toEqual(['./y.mjs', '/chunk.mjs', 'react']);
  });

  it('parseReexportStub returns the single internal target, else null', () => {
    expect(parseReexportStub('/* esm.sh */\nexport * from "/lucide-react@1.21.0/es2022/lucide-react.mjs";')).toBe(
      'https://esm.sh/lucide-react@1.21.0/es2022/lucide-react.mjs',
    );
    expect(parseReexportStub(LUCIDE_MJS)).toBeNull(); // real module, not a stub
    expect(parseReexportStub('export * from "/a.mjs"; export * from "/b.mjs";')).toBeNull(); // multi-target
  });
});

describe('parseBareSubpath — the subpath-retry predicate', () => {
  it('splits a bare subpath specifier, scoped and plain', () => {
    expect(parseBareSubpath('sql.js/dist/sql-asm.js')).toEqual({ name: 'sql.js', subpath: 'dist/sql-asm.js' });
    expect(parseBareSubpath('@scope/pkg/lib/thing.js')).toEqual({ name: '@scope/pkg', subpath: 'lib/thing.js' });
  });

  it('a bare package ROOT is not a subpath (the synthesis already covers it)', () => {
    expect(parseBareSubpath('react')).toBeNull();
    expect(parseBareSubpath('@scope/pkg')).toBeNull();
    expect(parseBareSubpath('')).toBeNull();
  });

  it('relative, absolute, node: and URL specifiers are out of scope', () => {
    expect(parseBareSubpath('./x.js')).toBeNull();
    expect(parseBareSubpath('../y.js')).toBeNull();
    expect(parseBareSubpath('/chunk.mjs')).toBeNull();
    expect(parseBareSubpath('node:fs')).toBeNull();
    expect(parseBareSubpath('https://esm.sh/x.mjs')).toBeNull();
    expect(parseBareSubpath('data:text/plain,x')).toBeNull();
  });
});

describe('fetchEsmFallbackSource', () => {
  it('follows a re-export stub to the real self-contained module', async () => {
    const fetcher: EsmFallbackFetcher = async (url) =>
      url.includes('lucide-react.mjs') ? LUCIDE_MJS : 'export * from "/lucide-react@1.21.0/es2022/lucide-react.mjs";';
    const src = await fetchEsmFallbackSource('https://esm.sh/lucide-react@^1.21.0?external=react', fetcher);
    expect(src).toBe(LUCIDE_MJS);
  });

  it('throws when the module still references esm.sh-internal chunks', async () => {
    const fetcher: EsmFallbackFetcher = async () => 'import x from "/chunk-abc.mjs";\nexport default x;';
    await expect(fetchEsmFallbackSource('https://esm.sh/big@1.0.0', fetcher)).rejects.toThrow(/internal chunk/);
  });
});

describe('synthesizeEsmFallbackModule', () => {
  it('packages the transpiled CJS as main with its require() deps', () => {
    const mod = synthesizeEsmFallbackModule('lucide-react', '^1.21.0', 'module.exports = {};', ['react']);
    expect(JSON.parse((mod.f['package.json'] as ICDNModuleFile).c)).toMatchObject({
      name: 'lucide-react',
      main: 'index.js',
    });
    const index = mod.f['index.js'] as ICDNModuleFile;
    expect(index.t).toBe(true);
    expect(index.d).toEqual(['react']);
  });
});

// ---------------------------------------------------------------------------
// The native subpath rail (R3-820): range→exact version probe + raw file fetch.
// Network stubbed at retryFetch; the memo, its eviction and the cache-bypass
// routing are the units under test.
// ---------------------------------------------------------------------------
describe('nativeEsmFallbackSubpathLoader — version pin + raw file fetch', () => {
  beforeEach(() => {
    mockedRetryFetch.mockReset();
  });

  it('probes the range OUTSIDE the immutable cache, then fetches the file at the exact version', async () => {
    mockedRetryFetch.mockImplementation(async (input: RequestInfo, init?: { bypassImmutableCache?: boolean }) => {
      const url = String(input);
      if (url.endsWith('/package.json')) {
        expect(init?.bypassImmutableCache).toBe(true); // a range URL must not ride the persistent cache
        return jsonResponse(JSON.stringify({ version: '1.14.2' }));
      }
      expect(init?.bypassImmutableCache).toBeUndefined(); // exact-version URLs may cache
      return jsonResponse('// raw tarball bytes');
    });
    await expect(nativeEsmFallbackSubpathLoader('sql.js', '^1.14.2', 'dist/sql-asm.js')).resolves.toBe(
      '// raw tarball bytes',
    );
    expect(mockedRetryFetch).toHaveBeenNthCalledWith(1, 'https://unpkg.com/sql.js@^1.14.2/package.json', {
      maxRetries: 5,
      bypassImmutableCache: true,
    });
    expect(mockedRetryFetch).toHaveBeenNthCalledWith(2, 'https://unpkg.com/sql.js@1.14.2/dist/sql-asm.js', {
      maxRetries: 5,
    });
  });

  it('pins the range: a second subpath of the same package reuses the resolved version, no re-probe', async () => {
    mockedRetryFetch.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/package.json')) return jsonResponse(JSON.stringify({ version: '2.3.4' }));
      return jsonResponse(`bytes of ${url}`);
    });
    await nativeEsmFallbackSubpathLoader('pin-fixture', '^2', 'a.js');
    await nativeEsmFallbackSubpathLoader('pin-fixture', '^2', 'b.js');
    const urls = mockedRetryFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith('/package.json'))).toHaveLength(1); // probe ran once
    expect(urls).toContain('https://unpkg.com/pin-fixture@2.3.4/b.js'); // both files at the SAME exact version
  });

  it('a failed probe is not memoized: the next materialization re-probes and succeeds', async () => {
    let attempts = 0;
    mockedRetryFetch.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/package.json')) {
        attempts += 1;
        if (attempts === 1) throw new Error('transient network failure');
        return jsonResponse(JSON.stringify({ version: '3.1.0' }));
      }
      return jsonResponse('bytes');
    });
    await expect(nativeEsmFallbackSubpathLoader('evict-fixture', '^3', 'a.js')).rejects.toThrow(
      'transient network failure',
    );
    await expect(nativeEsmFallbackSubpathLoader('evict-fixture', '^3', 'a.js')).resolves.toBe('bytes');
    expect(attempts).toBe(2); // the eviction re-issued the probe
  });

  it('a package.json without a version field fails with the package named', async () => {
    mockedRetryFetch.mockImplementation(async (input: RequestInfo) =>
      String(input).endsWith('/package.json')
        ? jsonResponse(JSON.stringify({ name: 'noversion-fixture' }))
        : jsonResponse('bytes'),
    );
    await expect(nativeEsmFallbackSubpathLoader('noversion-fixture', '^4', 'a.js')).rejects.toThrow(
      /noversion-fixture@\^4.*carries no version/,
    );
  });

  it('a non-ok file response (the parent-forwarded bridge path) surfaces as an HTTP error', async () => {
    mockedRetryFetch.mockImplementation(async (input: RequestInfo) =>
      String(input).endsWith('/package.json')
        ? jsonResponse(JSON.stringify({ version: '5.0.0' }))
        : jsonResponse('not found', 404),
    );
    await expect(nativeEsmFallbackSubpathLoader('notfound-fixture', '^5', 'gone.js')).rejects.toThrow(
      /HTTP 404 fetching unpkg notfound-fixture@5\.0\.0\/gone\.js/,
    );
  });
});
