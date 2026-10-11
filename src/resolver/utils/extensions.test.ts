import { DEFAULT_EXTENSIONS, importerAwareExtensions } from './extensions';

// R3-577 — the importer-aware extension order (see extensions.ts for the why).
describe('importerAwareExtensions', () => {
  const DEFAULT = DEFAULT_EXTENSIONS;

  it('a .cjs importer tries .cjs first, the rest of the order unchanged', () => {
    expect(importerAwareExtensions('/app/node_modules/pkg/dist/index.cjs', DEFAULT)).toEqual([
      '.cjs',
      '.js',
      '.jsx',
      '.mjs',
      '.ts',
      '.tsx',
      '.mdx',
    ]);
  });

  it('every other importer gets the input order back verbatim (and the same array — no copy)', () => {
    for (const name of ['/app/dist/index.js', '/app/dist/index.mjs', '/app/src/App.tsx', '/app/pkg/index.cjs.js']) {
      expect(importerAwareExtensions(name, DEFAULT)).toBe(DEFAULT);
    }
  });

  it('an extension list without .cjs is untouched even for a .cjs importer', () => {
    const cssOnly = ['.css'];
    expect(importerAwareExtensions('/app/dist/x.cjs', cssOnly)).toBe(cssOnly);
  });

  it('a list already leading with .cjs is untouched', () => {
    const cjsFirst = ['.cjs', '.js'];
    expect(importerAwareExtensions('/app/dist/x.cjs', cjsFirst)).toBe(cjsFirst);
  });

  it('never mutates the input', () => {
    const input = [...DEFAULT];
    importerAwareExtensions('/app/dist/x.cjs', input);
    expect(input).toEqual(DEFAULT);
  });
});
