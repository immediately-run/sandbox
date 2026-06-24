/**
 * @jest-environment jsdom
 *
 * esm.sh fallback for packages the primary dependency CDN drops (e.g. a version
 * newer than its npm mirror knows — the real lucide-react@^1.21.0 repro). The
 * dropped package is loaded as a native ES module from esm.sh and bridged into
 * the bundler's CommonJS graph via a synthetic single-file package. These tests
 * stub the network boundary (jsdom can't import remote ESM) and verify the wiring
 * end to end: drop → fallback registered → namespace stashed → shim re-exports it.
 * (jsdom: importing ModuleRegistry transitively loads the evaluation runtime,
 * which references `window`/`self` at module scope.)
 */
import { ModuleRegistry } from '.';
import { Bundler } from '../bundler';
import {
  EsmFallbackLoader,
  ESM_FALLBACK_GLOBAL,
  esmFallbackShim,
  esmFallbackUrl,
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

// The primary CDN resolves react but silently drops lucide-react@^1.21.0.
const REACT_RESOLVED: IResolvedDependency[] = [
  { n: 'react', v: '19.3.0', d: 0 },
  { n: 'react-dom', v: '19.3.0', d: 0 },
  { n: 'scheduler', v: '0.28.0', d: 1 },
];

const DEPS = { 'lucide-react': '^1.21.0', react: '^19.2.5', 'react-dom': '^19.2.5' };

// Stand-in for the live esm.sh module namespace (named icon exports + default).
const Search = () => null;
const Camera = () => null;
const fakeLucideNamespace = { Search, Camera, default: { Search, Camera } };

/** Run a synthetic-package shim the way the evaluator does: in a scope with
 *  `global` and a fresh `exports`. Returns the populated `exports`. */
function runShim(code: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  // eslint-disable-next-line no-new-func
  new Function('global', 'exports', code)(globalThis, exports);
  return exports;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ESM_FALLBACK_GLOBAL];
});

describe('esmFallbackUrl', () => {
  it('pins react/react-dom versions from the resolved manifest via ?deps', () => {
    expect(esmFallbackUrl('lucide-react', '^1.21.0', REACT_RESOLVED)).toBe(
      'https://esm.sh/lucide-react@^1.21.0?deps=react@19.3.0,react-dom@19.3.0',
    );
  });

  it('omits ?deps when no react is present', () => {
    expect(esmFallbackUrl('left-pad', '^1.3.0', [])).toBe('https://esm.sh/left-pad@^1.3.0');
  });
});

describe('esmFallbackShim', () => {
  it('re-exports the stashed namespace with named exports, default, and __esModule', () => {
    (globalThis as Record<string, unknown>)[ESM_FALLBACK_GLOBAL] = { 'lucide-react': fakeLucideNamespace };
    const exports = runShim(esmFallbackShim('lucide-react'));
    expect(exports.__esModule).toBe(true);
    expect(exports.Search).toBe(Search); // `import { Search } from 'lucide-react'`
    expect(exports.Camera).toBe(Camera);
    expect(exports.default).toBe(fakeLucideNamespace.default); // `import Lucide from 'lucide-react'`
  });

  it('throws a clear error if the namespace was never preloaded', () => {
    expect(() => runShim(esmFallbackShim('lucide-react'))).toThrow(/was not preloaded/);
  });
});

describe('synthesizeEsmFallbackModule', () => {
  it('produces a single-file package whose main is the shim', () => {
    const mod = synthesizeEsmFallbackModule('lucide-react', '^1.21.0');
    expect(JSON.parse((mod.f['package.json'] as ICDNModuleFile).c)).toMatchObject({
      name: 'lucide-react',
      main: 'index.js',
    });
    expect((mod.f['index.js'] as ICDNModuleFile).t).toBe(true); // precompiled — not re-transpiled
    expect(mod.m).toEqual([]);
  });
});

describe('ModuleRegistry esm.sh fallback wiring', () => {
  const registry = (loader: EsmFallbackLoader | null) => new ModuleRegistry({} as Bundler, loader);

  beforeEach(() => {
    mockedFetchManifest.mockReset();
    mockedFetchModule.mockReset();
    // Fresh copy per call: the registry mutates `this.manifest` in place when it
    // appends fallbacks (fine in prod — each fetch decodes a new array).
    mockedFetchManifest.mockImplementation(async () => REACT_RESOLVED.map((d) => ({ ...d }))); // lucide-react dropped
    mockedFetchModule.mockResolvedValue({ f: {}, m: [] }); // react/react-dom: empty stub
  });

  it('registers a fallback, appends it to the manifest, and never hits the primary CDN for it', async () => {
    const loader = jest.fn().mockResolvedValue(fakeLucideNamespace);
    const r = registry(loader);

    await r.fetchManifest({ ...DEPS });

    expect(r.manifest.map((d) => d.n)).toContain('lucide-react');
    await r.preloadModules();

    // esm.sh loader was called with the right URL; primary fetchModule was not used for lucide.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith('https://esm.sh/lucide-react@^1.21.0?deps=react@19.3.0,react-dom@19.3.0');
    expect(mockedFetchModule).not.toHaveBeenCalledWith('lucide-react', expect.anything());
  });

  it('bridges the loaded namespace so requiring lucide-react yields its icons', async () => {
    const loader = jest.fn().mockResolvedValue(fakeLucideNamespace);
    const r = registry(loader);

    await r.fetchManifest({ ...DEPS });
    await r.preloadModules();

    // The namespace is stashed on the global the shim reads.
    expect(
      (globalThis as unknown as Record<string, Record<string, unknown>>)[ESM_FALLBACK_GLOBAL]['lucide-react'],
    ).toBe(fakeLucideNamespace);

    // Evaluating the synthetic package's entry (as the bundler would) yields the icons.
    const synthetic = r.modules.get('lucide-react')!;
    const indexJs = synthetic.files['index.js'] as ICDNModuleFile;
    const exports = runShim(indexJs.c);
    expect(exports.Search).toBe(Search);
    expect(exports.Camera).toBe(Camera);
  });

  it('surfaces a clear error (not a silent undefined) when esm.sh also fails', async () => {
    const loader = jest.fn().mockRejectedValue(new Error('404 Not Found'));
    const r = registry(loader);

    await r.fetchManifest({ ...DEPS });
    await expect(r.preloadModules()).rejects.toThrow(/Could not resolve "lucide-react@\^1\.21\.0".*esm\.sh fallback.*404/);
  });

  it('with the fallback disabled, a dropped package fails fast via assertDependenciesResolved', async () => {
    const r = registry(null);
    await expect(r.fetchManifest({ ...DEPS })).rejects.toThrow(/Could not resolve.*lucide-react@\^1\.21\.0/);
  });
});
