import { JSONTransformer } from './index';
import type { ITranspilationContext } from '../Transformer';

const ctx = (code: string, filepath = '/app/data.json'): ITranspilationContext =>
  ({ code, module: { filepath } } as unknown as ITranspilationContext);

describe('JSONTransformer', () => {
  const t = new JSONTransformer();

  it('emits the parsed value as a CommonJS export with no dependencies', async () => {
    const out = await t.transform(ctx('{"a":1,"b":["x"]}'));
    expect(out).toEqual({ code: 'module.exports = {"a":1,"b":["x"]};', dependencies: new Set() });
  });

  it('evaluates to a value deep-equal to the source JSON', async () => {
    const value = { name: '@scope/pkg', nested: { list: [1, 2, 3], flag: true }, nul: null };
    const out = (await t.transform(ctx(JSON.stringify(value, null, 2)))) as { code: string };
    // Evaluate the emitted module the way the runtime would.
    const module = { exports: {} as unknown };
    // eslint-disable-next-line no-new-func
    new Function('module', out.code)(module);
    expect(module.exports).toEqual(value);
  });

  it('normalizes away a BOM and trailing whitespace rather than pasting the source', async () => {
    const out = (await t.transform(ctx('﻿{"a":1}\n\n  '))) as { code: string };
    expect(out.code).toBe('module.exports = {"a":1};');
  });

  it('fails NAMING THE FILE, not as an opaque syntax error inside the CJS wrapper', async () => {
    await expect(t.transform(ctx('{ not json ', '/node_modules/@scope/lib/x.json'))).rejects.toThrow(
      /Invalid JSON in \/node_modules\/@scope\/lib\/x\.json/,
    );
  });

  it('handles a top-level array and a bare scalar', async () => {
    expect(((await t.transform(ctx('[1,2]'))) as { code: string }).code).toBe('module.exports = [1,2];');
    expect(((await t.transform(ctx('"hi"'))) as { code: string }).code).toBe('module.exports = "hi";');
  });
});
