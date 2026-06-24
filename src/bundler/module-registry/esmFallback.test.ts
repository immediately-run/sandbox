/**
 * @jest-environment jsdom
 *
 * esm.sh fallback (transpile-through, shared React) for packages the primary CDN
 * drops — the real lucide-react@^1.21.0 repro. The dropped package's esm.sh source
 * is fetched with deps externalized and transpiled through the bundler's chain, so
 * its `require("react")` binds to the APP's React (no dual-React render crash).
 * These tests stub the network boundary (jsdom can't fetch esm.sh) and run the
 * real transpile, verifying the wiring end to end.
 * (jsdom: importing ModuleRegistry transitively loads the evaluation runtime,
 * which references `window`/`self` at module scope.)
 */
import { ModuleRegistry } from '.';
import { Bundler } from '../bundler';
import {
  EsmFallbackFetcher,
  esmFallbackEntryUrl,
  fetchEsmFallbackSource,
  importedSpecifiers,
  isEsmInternal,
  parseReexportStub,
  synthesizeEsmFallbackModule,
} from './esm-fallback';
import { fetchManifest, fetchModule, ICDNModuleFile, IResolvedDependency } from './module-cdn';

jest.mock('./module-cdn', () => ({
  ...jest.requireActual('./module-cdn'),
  fetchManifest: jest.fn(),
  fetchModule: jest.fn(),
}));

const mockedFetchManifest = fetchManifest as jest.MockedFunction<typeof fetchManifest>;
const mockedFetchModule = fetchModule as jest.MockedFunction<typeof fetchModule>;

// Primary CDN resolves react/react-dom but drops lucide-react@^1.21.0.
const REACT_RESOLVED: IResolvedDependency[] = [
  { n: 'react', v: '19.3.0', d: 0 },
  { n: 'react-dom', v: '19.3.0', d: 0 },
  { n: 'scheduler', v: '0.28.0', d: 1 },
];
const DEPS = { 'lucide-react': '^1.21.0', react: '^19.2.5', 'react-dom': '^19.2.5' };

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

describe('ModuleRegistry esm.sh fallback (transpile-through)', () => {
  const registry = (fetcher: EsmFallbackFetcher | null) => new ModuleRegistry({} as Bundler, fetcher);

  beforeEach(() => {
    mockedFetchManifest.mockReset();
    mockedFetchModule.mockReset();
    mockedFetchManifest.mockImplementation(async () => REACT_RESOLVED.map((d) => ({ ...d }))); // lucide dropped
    mockedFetchModule.mockResolvedValue({ f: {}, m: [] }); // react/react-dom stubs
  });

  it('externalizes react and bridges the package so require() resolves it (no second React)', async () => {
    const fetcher = jest.fn<Promise<string>, [string]>().mockResolvedValue(LUCIDE_MJS);
    const r = registry(fetcher);

    await r.fetchManifest({ ...DEPS });
    expect(r.manifest.map((d) => d.n)).toContain('lucide-react');
    await r.preloadModules();

    // Fetched from esm.sh with the resolved deps externalized.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = fetcher.mock.calls[0][0];
    expect(url).toContain('https://esm.sh/lucide-react@^1.21.0');
    expect(url).toMatch(/external=[^&]*react/);

    // The synthetic package is transpiled CJS whose dep is react — so at eval the
    // bundler resolves `react` to the app's shared instance (the dual-React fix).
    const synthetic = r.modules.get('lucide-react')!;
    const index = synthetic.files['index.js'] as ICDNModuleFile;
    expect(index.c).toMatch(/require\(["']react["']\)/);
    expect(index.c).not.toMatch(/import\s/); // ESM was lowered to CJS
    expect(index.d).toContain('react');
  });

  it('surfaces a clear error (not a silent undefined) when esm.sh also fails', async () => {
    const fetcher = jest.fn<Promise<string>, [string]>().mockRejectedValue(new Error('HTTP 404'));
    const r = registry(fetcher);
    await r.fetchManifest({ ...DEPS });
    await expect(r.preloadModules()).rejects.toThrow(/Could not resolve "lucide-react@\^1\.21\.0".*esm\.sh fallback.*404/);
  });

  it('with the fallback disabled, a dropped package fails fast via the resolution guard', async () => {
    const r = registry(null);
    await expect(r.fetchManifest({ ...DEPS })).rejects.toThrow(/Could not resolve.*lucide-react@\^1\.21\.0/);
  });
});
