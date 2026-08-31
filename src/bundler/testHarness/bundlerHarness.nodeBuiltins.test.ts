// R3-411 — regression fixtures: `node:` builtins, per-file dependency
// isolation, and BigInt literals.
//
// The finding (2026-08-27/28, sqlite-studio + chess host verifications):
//  - `sql.js` died with `Cannot find module 'node:fs'` from a file the app
//    never imported — the registry added EVERY file of the fetched package as
//    a dependency, the resolver had no `node:` mapping, and there was no
//    `crypto` shim.
//  - `chess.js` 1.4 died with `return0n is not defined` — a BigInt literal
//    fused by the transpile path (the library's Zobrist hashing uses them).
//
// Both apps had to vendor patched copies. These fixtures pin the platform
// behavior that makes the npm packages work un-vendored.

import { transformBabel } from '@immediately-run/transpiler';

import { CRYPTO_MODULE_CODE, UNSUPPORTED_BUILTIN_MODULE_CODE, UNSUPPORTED_BUILTIN_MODULE_PATH } from '../shims';
import { underAppRoot } from '../../fsLayout';
import { ModuleNotFoundError } from '../../errors/ModuleNotFound';
import { ModuleRegistry } from '../module-registry';
import { NodeModule } from '../module-registry/NodeModule';
import { Bundler } from '../bundler';
import { Module } from '../module/Module';
import { scanCjsModule } from '../transforms/raw-cjs/scan';
import { RawCjsTransformer } from '../transforms/raw-cjs';
import { createBundlerHarness, type BundlerHarness } from './bundlerHarness';

// ---------------------------------------------------------------------------
// 1. BigInt literals — the chess.js shape (Zobrist hashing), un-vendored.
// ---------------------------------------------------------------------------

// A chess.js@1.4-shaped excerpt: Zobrist keys as BigInt literals in every
// numeric-literal spelling (decimal, hex, binary, underscored), behind a
// `return`, in an array, and as an object value.
const CHESS_SHAPED_BIGINT = `
"use strict";
var PIECES = { PAWN: 1n, KNIGHT: 2n, BISHOP: 4n };
var KEYS = [0x0fn, 0b101n, 1_000n];
function hash (square) {
  if (square === null) { return 0n; }
  return KEYS[square % KEYS.length] ** 2n;
}
module.exports = { PIECES: PIECES, KEYS: KEYS, hash: hash };
`;

describe('R3-411 — BigInt literals survive every transpile stage', () => {
  it('the raw-CJS scanner classifies and collects requires without touching the code', () => {
    const scan = scanCjsModule(CHESS_SHAPED_BIGINT);
    expect(scan.isEsm).toBe(false);
    expect(scan.requires).toEqual([]);
  });

  it('the raw-CJS transformer returns the source byte-for-byte (no token fusing)', async () => {
    const t = new RawCjsTransformer();
    const out = await t.transform({
      code: CHESS_SHAPED_BIGINT,
      filepath: '/node_modules/chess.js/chess.utils.js',
    } as never);
    expect(out.code).toEqual(CHESS_SHAPED_BIGINT);
  });

  it('the Babel transform preserves BigInt literals (return 0n stays two tokens)', async () => {
    const code = `export const hash = () => { return 0n; };\nexport const k = 123n + 4n;\n`;
    const out = await transformBabel({ code, filepath: '/app/src/zobrist.ts', config: {} });
    // The fused-token regression was `return0n` — assert the separator survives.
    expect(out.code).toMatch(/return\s+0n;/);
    expect(out.code).not.toMatch(/return0n/);
    expect(out.code).toMatch(/123n\s*\+\s*4n/);
  });
});

// ---------------------------------------------------------------------------
// 2. `node:` builtins — strip the prefix, shim crypto, stub the rest.
// ---------------------------------------------------------------------------

describe('R3-411 — node: builtins resolve to the platform shims', () => {
  it('the crypto shim: random works, hashing throws only when CALLED', () => {
    const module = { exports: {} as Record<string, unknown> };
    new Function('module', 'exports', CRYPTO_MODULE_CODE)(module, module.exports);
    const crypto = module.exports as Record<string, (...args: unknown[]) => unknown>;

    const bytes = crypto.randomBytes(16) as Uint8Array;
    expect(bytes).toHaveLength(16);
    const again = crypto.randomBytes(16) as Uint8Array;
    expect([...again]).not.toEqual([...bytes]); // actually random

    // Hashing APIs are throw-on-call, not silently wrong. (Message text is the
    // reviewed shim's — "not supported … use crypto.subtle" — matched loosely so
    // the pin is the throw itself, not the wording.)
    expect(() => (crypto.createHash as (a: string) => unknown)('sha256')).toThrow(/crypto\.createHash/);
  });

  it('the unsupported-builtin stub: any property access yields a throwing function', () => {
    const module = { exports: {} as Record<string, unknown> };
    new Function('module', 'exports', UNSUPPORTED_BUILTIN_MODULE_CODE)(module, module.exports);
    const stub = module.exports as Record<string, () => unknown>;
    expect(() => (stub.spawn as () => unknown)()).toThrow(/not available in the browser sandbox/);
    expect(() => (stub.exec as () => unknown)()).toThrow(/not available in the browser sandbox/);
  });

  it('end-to-end: one harness — BigInt literals AND node:-builtin imports (the two findings in one boot)', async () => {
    const h = await createBundlerHarness(
      {
        'package.json': JSON.stringify({ name: 'r3-411-fixture', main: 'src/index.ts' }),
        'src/index.ts': `import * as path from 'node:path';\nimport * as crypto from 'node:crypto';\nimport * as bare from 'path';\nimport { hash } from './zobrist';\nexport const k = typeof path.join + typeof crypto.randomBytes + typeof bare.join + hash(3);\n`,
        'src/zobrist.ts': `"use strict";\nvar PIECES = { PAWN: 1n, KNIGHT: 2n, BISHOP: 4n };\nvar KEYS = [0x0fn, 0b101n, 1_000n];\nfunction hash (square) {\n  if (square === null) { return 0n; }\n  return KEYS[square % KEYS.length] ** 2n;\n}\nexport { PIECES, KEYS, hash };\n`,
      },
      { forCompile: false },
    );
    try {
      await h.bundler.initPreset('create-react-app');
      // The full compile path preloads the shims (bundler.ts preloadModules);
      // the harness's transpile smoke does not — do it explicitly so
      // /node_modules/{path,fs,crypto,__node-unsupported} exist for resolution.
      await h.bundler.preloadModules();
      const entry = await h.bundler.transformModule(underAppRoot('/src/index.ts'));
      // The node:-prefixed and bare spellings BOTH land on the preloaded shim.
      expect([...entry.dependencies]).toContain('/node_modules/path/index.js');
      expect([...entry.dependencies]).toContain('/node_modules/crypto/index.js');

      // The BigInt module transpiles with its literals intact — a fused
      // `return0n` is exactly the regression (it only fails at EVALUATION, as a
      // ReferenceError, which is what killed chess.js).
      const zobrist = await h.bundler.transformModule(underAppRoot('/src/zobrist.ts'));
      expect(typeof zobrist.compiled).toBe('string');
      expect(zobrist.compiled).toMatch(/0n/);
      expect(zobrist.compiled).not.toMatch(/return0n/);
    } finally {
      await h.teardown();
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// 3. Per-file dependency isolation — a guarded require in an UNRELATED file of
//    a fetched package must not fail the app (the sql.js shape).
// ---------------------------------------------------------------------------

describe('R3-411 — a precompiled package deps never fail the load', () => {
  const stubBundler = (): Bundler =>
    ({
      modules: new Map<string, Module>(),
      resolveAsync: async (specifier: string) => {
        throw new ModuleNotFoundError(specifier, '/node_modules/sql.js/dist/sql-wasm-debug.js');
      },
      addInitiator: () => undefined,
      transformModule: () => undefined,
    } as unknown as Bundler);

  it('an unresolvable builtin dep maps to the unsupported stub, not a rejection', async () => {
    const bundler = stubBundler();
    const registry = new ModuleRegistry(bundler, null);
    // sql.js's shape: the ENTRY (sql-asm.js) has normal deps; an UNRELATED
    // debug file guards require('node:child_process') behind isNode checks.
    registry.modules.set(
      'sql.js',
      new NodeModule(
        'sql.js',
        '1.13.0',
        {
          'dist/sql-asm.js': { c: 'module.exports = 1;', d: ['fs'], t: true },
          'dist/sql-wasm-debug.js': { c: 'module.exports = 2;', d: ['node:child_process', 'crypto'], t: true },
        },
        [],
      ),
    );

    // Before R3-411 this rejected with ModuleNotFoundError and killed the app.
    await registry.loadModuleDependencies();

    const unrelated = bundler.modules.get('/node_modules/sql.js/dist/sql-wasm-debug.js');
    expect(unrelated).toBeDefined();
    expect(unrelated!.dependencyMap.get('node:child_process')).toBe(UNSUPPORTED_BUILTIN_MODULE_PATH);
    expect(unrelated!.dependencyMap.get('crypto')).toBe(UNSUPPORTED_BUILTIN_MODULE_PATH);
    expect(unrelated!.dependencies.has(UNSUPPORTED_BUILTIN_MODULE_PATH)).toBe(true);
  });

  it('a NON-resolution error still propagates (only resolution misses are absorbed)', async () => {
    const bundler = {
      ...stubBundler(),
      resolveAsync: async () => {
        throw new Error('network down');
      },
    } as unknown as Bundler;
    const registry = new ModuleRegistry(bundler, null);
    registry.modules.set(
      'boom',
      new NodeModule('boom', '1.0.0', { 'index.js': { c: 'module.exports=1', d: ['anything'], t: true } }, []),
    );
    await expect(registry.loadModuleDependencies()).rejects.toThrow('network down');
  });
});
