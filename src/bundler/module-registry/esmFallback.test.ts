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
  parseBareSubpath,
  parseReexportStub,
  synthesizeEsmFallbackModule,
} from './esm-fallback';
import { ICDNModuleFile } from './module-cdn';

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
