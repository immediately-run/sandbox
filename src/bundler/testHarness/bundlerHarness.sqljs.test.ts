// R3-426 — the REAL-package proof: sql.js (SQLite compiled to wasm, Emscripten
// loader) boots through the booted bundler and answers a query.
//
// The fixture is the published sql.js@1.14.2 `dist/sql-wasm.js` + `dist/sql-wasm.wasm`,
// vendored verbatim under ./fixtures/sqljs (checked in — tests must not hit the
// network). The app follows the DOCUMENTED convention for packages whose loader
// computes its own wasm URL: pass `locateFile` resolving against `import.meta.url`
// (see moduleSpaceFetch.ts). That composes every R3-426 piece at once:
//
//  - `import.meta.url` (R3-328 shim) resolves the module's own module-space URL;
//  - `new URL(file, import.meta.url)` lands on the sibling `.wasm` in the mounted tree;
//  - Emscripten's own `fetch(wasmUrl)` (streaming-first) hits the evaluator's fetch
//    shadow, which serves the bytes with `Content-Type: application/wasm`;
//  - the 658KB wasm instantiates, and `select 2+3` returns 5 from actual SQLite.
import fs from 'fs';
import path from 'path';

import { REACT_REFRESH_BABEL_CONFIG, transformBabel } from '@immediately-run/transpiler';

import { NodeModule } from '../module-registry/NodeModule';
import { createBundlerHarness, installEvalGlobals, type BundlerHarness } from './bundlerHarness';

const SQLJS_DIR = path.join(__dirname, 'fixtures', 'sqljs');
const SQL_WASM_JS = fs.readFileSync(path.join(SQLJS_DIR, 'sql-wasm.js'), 'utf8');

const SQLJS_FIXTURE: Record<string, string | Uint8Array> = {
  'package.json': JSON.stringify({ name: 'sqljs-fixture', main: 'src/main' }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/main.ts':
    "import initSqlJs from './sql-wasm.js';\n" +
    'const g = globalThis as Record<string, unknown>;\n' +
    'g.__sqljsResult = (async () => {\n' +
    '  const SQL = await initSqlJs({\n' +
    '    locateFile: (file: string) => new URL(`./${file}`, import.meta.url).href,\n' +
    '  });\n' +
    '  const db = new SQL.Database();\n' +
    "  const res = db.exec('select 2+3 as v');\n" +
    '  db.close();\n' +
    '  return res[0].values[0][0];\n' +
    '})();\n' +
    'export default 1;\n',
  'src/sql-wasm.js': SQL_WASM_JS,
  'src/sql-wasm.wasm': new Uint8Array(fs.readFileSync(path.join(SQLJS_DIR, 'sql-wasm.wasm'))),
};

/** Seed a stub `core-js` into the bundler's ModuleRegistry. preset-env
 *  (`useBuiltIns: 'usage'`) injects `require('core-js/modules/...')` into the ES5
 *  Emscripten loader; in production those resolve through the real registry/CDN, but
 *  the harness's network spy serves no packages. The stubs are empty modules — honest
 *  here, because the test runtime natively provides everything sql.js touches. The
 *  exact set is discovered by running the file through the SAME transform the bundler
 *  will use, so the seed can never drift from what preset-env injects. */
async function seedCoreJsStubs(h: BundlerHarness): Promise<void> {
  const { dependencies } = await transformBabel({
    code: SQL_WASM_JS,
    filepath: '/app/src/sql-wasm.js',
    config: REACT_REFRESH_BABEL_CONFIG,
  });
  const stub = { c: 'module.exports = {};', d: [], t: false };
  const files: Record<string, typeof stub> = {
    'package.json': { c: JSON.stringify({ name: 'core-js', version: '3.22.7', main: 'index.js' }), d: [], t: false },
    'index.js': stub,
  };
  for (const dep of dependencies) {
    if (dep.startsWith('core-js/')) {
      files[dep.slice('core-js/'.length)] = stub;
    }
  }
  h.bundler.moduleRegistry.modules.set('core-js', new NodeModule('core-js', '3.22.7', files, []));
}

const testGlobals = globalThis as Record<string, unknown>;

describe('R3-426 — sql.js (real Emscripten loader + 658KB wasm) through the booted bundler', () => {
  let h: BundlerHarness;
  let restore: () => void;

  beforeAll(async () => {
    restore = installEvalGlobals();
    h = await createBundlerHarness(SQLJS_FIXTURE, { forCompile: true });
    await seedCoreJsStubs(h);
    const evaluate = await h.bundler.compile();
    // Emscripten sniffs Node via `globalThis.process?.versions?.node` — present under
    // jest, ABSENT in the real sandbox frame. Mask it for the synchronous evaluation
    // (where the loader captures its environment flags) so the loader takes its web
    // path — `fetch` + `instantiateStreaming` — like it does on the platform.
    const g = globalThis as Record<string, unknown>;
    const realProcess = g.process;
    g.process = undefined;
    try {
      (evaluate as () => unknown)();
    } finally {
      g.process = realProcess;
    }
  }, 120000);

  afterAll(async () => {
    delete testGlobals.__sqljsResult;
    await h.teardown();
    restore();
  });

  it('initSqlJs({ locateFile: import.meta.url-relative }) boots SQLite and select 2+3 === 5', async () => {
    await expect(testGlobals.__sqljsResult).resolves.toBe(5);
  }, 120000);
});
