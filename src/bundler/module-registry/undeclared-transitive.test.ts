/**
 * ModuleRegistry (index.ts + undeclared-transitive.ts) — the dist-declared
 * transitive rescue (R3-1203).
 *
 * The recorded failure: the editor app declares `@codemirror/language: ^6.11.0`;
 * the primary CDN's mirror resolves the caret to 6.13.0 (newest it has
 * indexed), and 6.13.0's published dist imports `@codemirror/streamparser`
 * while its package.json does not declare it (upstream declared it only from
 * 6.13.1, which the mirror has not ingested). /dep_tree walks DECLARED
 * dependencies, so the boot's module graph omits the package and the editor
 * dies pre-render with `Cannot find module '@codemirror/streamparser' from
 * '/node_modules/@codemirror/language/dist/index.js'`.
 *
 * Fixtures below are the REAL 2026-10-13 answers, recorded verbatim: the CDN's
 * /dep_tree for the caret ask, the CDN's package-level `m` import list for
 * language@6.13.0, and esm.sh's re-export stub + es2022 module for the rescue
 * (esm.sh resolves `@*` to latest server-side — the CORS-clean way an
 * opaque-origin iframe resolves an unversioned name; unpkg's version-resolving
 * redirect carries no ACAO). The CDN seam is stubbed as in index.test.ts; the
 * esm.sh fetcher is the registry's own injected seam; the transpile runs for
 * real.
 */
import { ModuleRegistry } from '.';
import { Bundler } from '../bundler';
import { NodeModule } from './NodeModule';
import { ICDNModuleFile } from './module-cdn';
import type { EsmFallbackFetcher } from './esm-fallback';
import { fetchManifest, fetchModule, IResolvedDependency } from './module-cdn';
import { collectUndeclaredImports, UNDECLARED_IMPORT_RESCUE_BUDGET } from './undeclared-transitive';

jest.mock('./module-cdn', () => ({
  ...jest.requireActual('./module-cdn'),
  fetchManifest: jest.fn(),
  fetchModule: jest.fn(),
}));

const mockedFetchManifest = fetchManifest as jest.MockedFunction<typeof fetchManifest>;
const mockedFetchModule = fetchModule as jest.MockedFunction<typeof fetchModule>;

// The recorded /dep_tree answer for {"@codemirror/language":"^6.11.0"} —
// @codemirror/streamparser (and @lezer/lr, which the dist never imports) absent.
const LANGUAGE_CARET_TREE: IResolvedDependency[] = [
  { n: '@codemirror/language', v: '6.13.0', d: 0 },
  { n: '@lezer/highlight', v: '1.2.4', d: 1 },
  { n: '@lezer/common', v: '1.5.3', d: 1 },
  { n: 'style-mod', v: '4.1.4', d: 1 },
  { n: '@codemirror/view', v: '6.43.9', d: 1 },
  { n: '@codemirror/state', v: '6.7.5', d: 1 },
  { n: 'w3c-keyname', v: '2.2.8', d: 2 },
  { n: '@marijn/find-cluster-break', v: '1.0.3', d: 2 },
  { n: 'crelt', v: '1.0.6', d: 2 },
];

// The recorded package-level `m` for @codemirror/language@6.13.0 — the CDN's
// import list computed from the real dist, naming the undeclared transitive.
const LANGUAGE_6130_IMPORTS = [
  '@lezer/highlight',
  'style-mod',
  '@codemirror/streamparser',
  '@codemirror/state',
  '@lezer/common',
  '@codemirror/view',
];

// The recorded esm.sh answer at `@*` (the version-resolving re-export stub,
// verbatim) and the es2022 module it points at (verbatim, 1.7 kB — a pure
// leaf: no imports, so nothing to externalize).
const STREAMPARSER_REEXPORT_STUB =
  '/* esm.sh - @codemirror/streamparser@6.0.0 */\nexport * from "/@codemirror/streamparser@6.0.0/es2022/streamparser.mjs";\n';
const STREAMPARSER_ESM = `/* esm.sh - @codemirror/streamparser@6.0.0 */
function l(n,t,s,e=0,i=0){t==null&&(t=n.search(/[^\\s\\u00a0]/),t==-1&&(t=n.length));let h=i;for(let r=e;r<t;r++)n.charCodeAt(r)==9?h+=s-h%s:h++;return h}var o=class{constructor(t,s,e,i){this.string=t,this.tabSize=s,this.indentUnit=e,this.overrideIndent=i,this.pos=0,this.start=0,this.lastColumnPos=0,this.lastColumnValue=0}eol(){return this.pos>=this.string.length}sol(){return this.pos==0}peek(){return this.string.charAt(this.pos)||void 0}next(){if(this.pos<this.string.length)return this.string.charAt(this.pos++)}eat(t){let s=this.string.charAt(this.pos),e;if(typeof t=="string"?e=s==t:e=s&&(t instanceof RegExp?t.test(s):t(s)),e)return++this.pos,s}eatWhile(t){let s=this.pos;for(;this.eat(t););return this.pos>s}eatSpace(){let t=this.pos;for(;/[\\s\\u00a0]/.test(this.string.charAt(this.pos));)++this.pos;return this.pos>t}skipToEnd(){this.pos=this.string.length}skipTo(t){let s=this.string.indexOf(t,this.pos);if(s>-1)return this.pos=s,!0}backUp(t){this.pos-=t}column(){return this.lastColumnPos<this.start&&(this.lastColumnValue=l(this.string,this.start,this.tabSize,this.lastColumnPos,this.lastColumnValue),this.lastColumnPos=this.start),this.lastColumnValue}indentation(){var t;return(t=this.overrideIndent)!==null&&t!==void 0?t:l(this.string,null,this.tabSize)}match(t,s,e){if(typeof t=="string"){let i=r=>e?r.toLowerCase():r,h=this.string.substr(this.pos,t.length);return i(h)==i(t)?(s!==!1&&(this.pos+=t.length),!0):null}else{let i=this.string.slice(this.pos).match(t);return i&&i.index>0?null:(i&&s!==!1&&(this.pos+=i[0].length),i)}}current(){return this.string.slice(this.start,this.pos)}};export{o as StringStream};
//# sourceMappingURL=streamparser.mjs.map`;

/** The recorded esm.sh seam: the stub at `@*`, the es2022 module at the hop. */
const recordedEsmSh: EsmFallbackFetcher = async (url) => {
  if (url.includes('/@codemirror/streamparser@*')) return STREAMPARSER_REEXPORT_STUB;
  if (url.endsWith('/es2022/streamparser.mjs')) return STREAMPARSER_ESM;
  throw new Error(`unexpected esm.sh url ${url}`);
};

/** The registry under test: CDN stubs per case, one esm.sh fetcher seam. */
const registry = (esm: EsmFallbackFetcher | null) => new ModuleRegistry({} as Bundler, esm);

beforeEach(() => {
  mockedFetchManifest.mockReset();
  mockedFetchModule.mockReset();
});

describe('ModuleRegistry dist-declared transitive rescue (R3-1203)', () => {
  it('resolves the undeclared transitive of a caret-ranged direct dependency (the recorded editor boot)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedFetchManifest.mockResolvedValue(LANGUAGE_CARET_TREE.map((d) => ({ ...d })));
    mockedFetchModule.mockImplementation(async (name) => ({
      f: {},
      // Only language's package-level import list matters to the collector; the
      // recorded `m` names the transitive the tree omits.
      m: name === '@codemirror/language' ? [...LANGUAGE_6130_IMPORTS] : [],
    }));
    const r = registry(recordedEsmSh);

    await r.fetchManifest({ '@codemirror/language': '^6.11.0' });
    expect(r.manifest.map((d) => d.n)).not.toContain('@codemirror/streamparser'); // the recorded gap
    await r.preloadModules();

    // The rescue registered the package through the same synthesis a dropped
    // top-level dep takes: a transpiled entry at the package root.
    const rescued = r.modules.get('@codemirror/streamparser');
    expect(rescued).toBeDefined();
    const index = rescued!.files['index.js'] as ICDNModuleFile;
    expect(index).toBeDefined();
    expect(index.c).toMatch(/StringStream/); // the real module came through the real transpile
    expect(index.d).toEqual([]); // a pure leaf — nothing left to resolve
    // The manifest records the resolution (later fallback externals lists read it).
    expect(r.manifest).toContainEqual({ n: '@codemirror/streamparser', v: '*', d: 1 });
    // The operator is told, naming the importer and the action.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"@codemirror/language" imports "@codemirror/streamparser"'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('esm.sh fallback'));
    warn.mockRestore();
  });

  it('a rescued package whose module imports a further unknown package resolves it too (the fixpoint)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedFetchManifest.mockResolvedValue([{ n: 'parent-pkg', v: '1.0.0', d: 0 }]);
    mockedFetchModule.mockResolvedValue({ f: {}, m: ['child-pkg'] });
    const esm: EsmFallbackFetcher = async (url) => {
      if (url.includes('/child-pkg@*')) return `export { a } from "grandchild-pkg";\nexport const a2 = 1;\n`;
      if (url.includes('/grandchild-pkg@*')) return `export const b = 2;\n`;
      throw new Error(`unexpected esm.sh url ${url}`);
    };
    const r = registry(esm);

    await r.fetchManifest({ 'parent-pkg': '^1.0.0' });
    await r.preloadModules();

    expect(r.modules.has('child-pkg')).toBe(true);
    expect(r.modules.has('grandchild-pkg')).toBe(true);
    // The fixpoint seeded the child's bare import list from its transpiled entry.
    expect(r.modules.get('child-pkg')!.modules).toContain('grandchild-pkg');
    warn.mockRestore();
  });

  it('an unresolvable name degrades with a warning — the boot is not failed (the R3-411 bar)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedFetchManifest.mockResolvedValue([{ n: '@codemirror/language', v: '6.13.0', d: 0 }]);
    mockedFetchModule.mockResolvedValue({ f: {}, m: ['no-such-package-anywhere'] });
    const failing: EsmFallbackFetcher = async () => {
      throw new Error('HTTP 404 fetching https://esm.sh/no-such-package-anywhere@*');
    };
    const r = registry(failing);

    await r.fetchManifest({ '@codemirror/language': '^6.11.0' });
    await expect(r.preloadModules()).resolves.toBeUndefined();

    expect(r.modules.has('no-such-package-anywhere')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not rescue the undeclared import'),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it('the rescue budget bounds the boot: the limit is respected, the remainder named, the loop terminates', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // One package whose metadata names BUDGET+1 unknowns.
    const manyNames = Array.from({ length: UNDECLARED_IMPORT_RESCUE_BUDGET + 1 }, (_, i) => `unknown-pkg-${i}`);
    mockedFetchManifest.mockResolvedValue([{ n: 'metadata-chatter', v: '1.0.0', d: 0 }]);
    mockedFetchModule.mockResolvedValue({ f: {}, m: manyNames });
    const esm: EsmFallbackFetcher = async (url) => {
      if (/\/unknown-pkg-\d+@\*/.test(url)) return 'export const x = 1;\n';
      throw new Error(`unexpected esm.sh url ${url}`);
    };
    const r = registry(esm);

    await r.fetchManifest({ 'metadata-chatter': '^1.0.0' });
    await r.preloadModules();

    const rescuedCount = [...r.modules.keys()].filter((n) => n.startsWith('unknown-pkg-')).length;
    expect(rescuedCount).toBe(UNDECLARED_IMPORT_RESCUE_BUDGET);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown-pkg-20'));
    warn.mockRestore();
  });

  it('with the esm.sh fallback disabled, no rescue is attempted (the pre-R3-1203 behaviour)', async () => {
    mockedFetchManifest.mockResolvedValue([{ n: '@codemirror/language', v: '6.13.0', d: 0 }]);
    mockedFetchModule.mockResolvedValue({ f: {}, m: [...LANGUAGE_6130_IMPORTS] });
    const r = registry(null);

    await r.fetchManifest({ '@codemirror/language': '^6.11.0' });
    await expect(r.preloadModules()).resolves.toBeUndefined();
    expect(r.modules.has('@codemirror/streamparser')).toBe(false);
  });
});

describe('collectUndeclaredImports (the pure collector)', () => {
  const nodeModule = (name: string, imports: string[]): NodeModule => new NodeModule(name, '1.0.0', {}, imports);

  it('names the unknown package behind a subpath import, deduped across importers', () => {
    const modules = new Map<string, NodeModule>([
      [
        '@codemirror/language',
        nodeModule('@codemirror/language', ['@codemirror/state', '@codemirror/streamparser/stream']),
      ],
      ['other-pkg', nodeModule('other-pkg', ['@codemirror/streamparser', './local', '/absolute.js'])],
    ]);
    const candidates = collectUndeclaredImports(modules, new Set(['@codemirror/state']));
    expect(candidates).toEqual([{ name: '@codemirror/streamparser', importer: '@codemirror/language' }]);
  });

  it('skips builtin spellings, the shimmed names, self-references and known names', () => {
    const modules = new Map<string, NodeModule>([
      [
        'emscripten-pkg',
        nodeModule('emscripten-pkg', ['node:fs', 'node:child_process', 'fs', 'crypto', 'emscripten-pkg', 'known-pkg']),
      ],
    ]);
    expect(collectUndeclaredImports(modules, new Set(['known-pkg']))).toEqual([]);
  });
});
