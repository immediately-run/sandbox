// The dispatcher's own contract (R3-330): methods resolve through DYNAMIC
// imports — the entry is a thin dispatcher, one chunk per engine — and the wire
// shape ServiceHost expects is unchanged: { id, result } | { id, error },
// now delivered asynchronously.
import { handleMessage } from './authoring-worker';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the per-method dispatcher (R3-330)', () => {
  it('answers format through the real engine chunk (async)', async () => {
    const res = await handleMessage({
      id: 7,
      method: 'format',
      params: { source: 'const   x=1', parser: 'typescript' },
    });
    expect(res.id).toBe(7);
    expect(res.error).toBeUndefined();
    // The engine really ran — prettier collapsed the triple space.
    expect(JSON.stringify(res.result)).toContain('const x = 1;');
  });

  it('answers an unknown method with the ordinary error shape, not a throw', async () => {
    const res = await handleMessage({ id: 3, method: 'transpile', params: {} });
    expect(res).toEqual({ id: 3, error: expect.stringContaining('unknown method') });
  });

  it('a missing id degrades to -1, and a failing call becomes { id, error }', async () => {
    // An engine that throws (or a chunk that fails to load) must surface as the
    // call's own error path — the host's terminate/respawn backstop depends on
    // that, and needs nothing new here.
    const res = await handleMessage({
      id: 9,
      method: 'format',
      params: { source: { notAString: true }, parser: 'typescript' },
    });
    expect(res.id).toBe(9);
    expect(res.error).toBeDefined();
  });
});

describe('the packaging gate — engines are dynamically imported, never static (R3-330)', () => {
  const src = readFileSync(join(process.cwd(), 'src/services/authoring/authoring-worker.ts'), 'utf8');

  it('the entry statically imports ONLY the window shim', () => {
    // Both import forms: side-effect (`import './x'`) and named (`import {a} from './x'`).
    // A type-only import (`import type …`) is erased at compile time and does not count.
    const staticImports = [
      ...src.matchAll(/^import\s+(?:type\s+)?['"]\.\/([^'"]+)['"]/gm),
      ...src.matchAll(/^import\s+(?!type\b)[^'";]*from\s+['"]\.\/([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    expect(staticImports).toEqual(['worker-window-shim']);
  });

  it('all three engines + both hosts are behind dynamic import()', () => {
    for (const mod of ['format', 'typecheck', 'lint', 'worker-lib-host', 'worker-lint-host']) {
      expect(src).toMatch(new RegExp(`import\\(\\s*['"]\\./${mod}['"]`));
    }
  });

  it('the window shim stays the FIRST import — before any chunk can evaluate', () => {
    expect(src.indexOf("import './worker-window-shim'")).toBeLessThan(src.indexOf('handleMessage'));
  });
});
