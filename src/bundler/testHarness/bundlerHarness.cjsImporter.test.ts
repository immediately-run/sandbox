import gensync from 'gensync';

import { resolveAsync as rawResolveAsync } from '../../resolver/resolver';
import { importerAwareExtensions } from '../../resolver/utils/extensions';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// R3-577 — the 2026-09-06 front-door outage's mechanism, as a fixture: a
// dual-published package whose CJS build carries an EXTENSIONLESS internal require
// (tsup/esbuild's emit), with the ESM and CJS siblings side by side. Node-mode interop
// (`__toESM(require("./Omnibox"), 1)`) is only correct when the require meets the CJS
// sibling; the default .js-first order hands it the ESM build, and the interop wrapper
// reaches the consumer where the value belongs.
const DUAL_PKG = {
  'node_modules/dual-pkg/package.json': JSON.stringify({
    name: 'dual-pkg',
    version: '1.0.0',
    main: 'dist/index.cjs',
    module: 'dist/index.js',
  }),
  'node_modules/dual-pkg/dist/index.cjs': 'var O = require("./Omnibox");\nmodule.exports = O;\n',
  'node_modules/dual-pkg/dist/index.js': 'import O from "./Omnibox";\nexport default O;\n',
  // The two sibling builds, marked by a comment each so a read can tell them apart.
  'node_modules/dual-pkg/dist/Omnibox.js': '/* ESM build */ export default function Omnibox() {}\n',
  'node_modules/dual-pkg/dist/Omnibox.cjs': '/* CJS build */ module.exports = function Omnibox() {};\n',
};

describe('R3-577 — a .cjs importer meets its CJS sibling first', () => {
  let h: BundlerHarness;

  beforeEach(async () => {
    h = await createBundlerHarness({
      'package.json': JSON.stringify({ name: 'cjs-importer-fixture', main: 'src/index' }),
      'index.html': '<!doctype html><div id="root"></div>',
      'src/index.ts': 'export const x = 1;\n',
      ...DUAL_PKG,
    });
  });
  afterEach(() => h.teardown());

  it('the extensionless require inside a .cjs build resolves to the .cjs sibling', async () => {
    const resolved = await h.bundler.resolveAsync('./Omnibox', '/app/node_modules/dual-pkg/dist/index.cjs');
    expect(resolved).toBe('/app/node_modules/dual-pkg/dist/Omnibox.cjs');
  });

  it('the same specifier from an ESM importer still resolves to the .js build (unchanged)', async () => {
    const resolved = await h.bundler.resolveAsync('./Omnibox', '/app/node_modules/dual-pkg/dist/index.js');
    expect(resolved).toBe('/app/node_modules/dual-pkg/dist/Omnibox.js');
  });

  it('a .cjs importer in the SAME DIR as a .js importer does not share its memoized answer', async () => {
    const fromCjs = await h.bundler.resolveAsync('./Omnibox', '/app/node_modules/dual-pkg/dist/index.cjs');
    const fromJs = await h.bundler.resolveAsync('./Omnibox', '/app/node_modules/dual-pkg/dist/index.js');
    expect(fromCjs).not.toBe(fromJs);
  });

  it('FAULT INJECTION: without the importer-aware reorder, the fixture resolves the ESM sibling (the outage shape)', async () => {
    // The pre-fix behavior, driven through the RAW resolver with the default order —
    // the bundler's reorder is bypassed, so the .cjs importer meets the ESM build.
    // If this case ever goes green against the raw resolver, the fixture no longer
    // discriminates and the harness cases above prove nothing.
    const files = new Map<string, string>();
    const fsAny = (h.bundler as unknown as { fs: { isFile: unknown; readFile: unknown } }).fs;
    void files;
    const resolved = await rawResolveAsync('./Omnibox', {
      filename: '/app/node_modules/dual-pkg/dist/index.cjs',
      extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mdx'], // the pre-fix default
      isFile: fsAny.isFile as never,
      readFile: fsAny.readFile as never,
    });
    expect(resolved).toBe('/app/node_modules/dual-pkg/dist/Omnibox.js'); // the WRONG file — proof the fixture bites

    // …and the helper applied by hand restores the CJS answer (the fix, isolated):
    const fixed = await rawResolveAsync('./Omnibox', {
      filename: '/app/node_modules/dual-pkg/dist/index.cjs',
      extensions: importerAwareExtensions('/app/node_modules/dual-pkg/dist/index.cjs', [
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.ts',
        '.tsx',
        '.mdx',
      ]),
      isFile: fsAny.isFile as never,
      readFile: fsAny.readFile as never,
    });
    expect(fixed).toBe('/app/node_modules/dual-pkg/dist/Omnibox.cjs');
  });
});
