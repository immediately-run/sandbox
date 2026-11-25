import type { ICDNModuleFile } from './module-cdn';
import {
  deferredFailureModulePath,
  deferredFailureSource,
  deferredFailureWarning,
  packageNameOf,
  synthesizeDeferredFailureModule,
  type DeferredFailure,
} from './deferredFailures';

const FAILURE: DeferredFailure = {
  name: 'csv-parse',
  range: '^7.0.3',
  message: 'Could not resolve "csv-parse@^7.0.3" from the package CDN, and the esm.sh fallback (x) also failed',
};

/** Evaluate CommonJS source the way the bundler's runtime would, returning what it threw. */
const thrownBy = (source: string): unknown => {
  try {
    new Function('module', 'exports', 'require', source)({ exports: {} }, {}, () => ({}));
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('deferred dependency failures (R3-1383)', () => {
  it('the stub entry throws exactly the recorded message when evaluated', () => {
    const err = thrownBy(deferredFailureSource(FAILURE));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(FAILURE.message);
  });

  it('keeps a message with quotes, backslashes and newlines intact', () => {
    const message = 'a "quoted" \\ path\nsecond line </script>';
    expect((thrownBy(deferredFailureSource({ ...FAILURE, message })) as Error).message).toBe(message);
  });

  it('synthesizes a package whose main is the throwing entry', () => {
    const module = synthesizeDeferredFailureModule(FAILURE);
    const file = (name: string) => module.f[name] as ICDNModuleFile;
    expect(JSON.parse(file('package.json').c)).toEqual({ name: 'csv-parse', version: '^7.0.3', main: 'index.js' });
    expect(file('index.js').c).toBe(deferredFailureSource(FAILURE));
    expect(file('index.js').d).toEqual([]);
    expect(deferredFailureModulePath('csv-parse')).toBe('/node_modules/csv-parse/index.js');
  });

  it('warns naming the package, its range and the reason', () => {
    const warning = deferredFailureWarning(FAILURE);
    expect(warning).toContain('"csv-parse@^7.0.3"');
    expect(warning).toContain(FAILURE.message);
  });

  it.each([
    ['csv-parse', 'csv-parse'],
    ['csv-parse/sync', 'csv-parse'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/deep/file.js', '@scope/pkg'],
  ])('maps %s to its package %s', (specifier, name) => {
    expect(packageNameOf(specifier)).toBe(name);
  });

  it.each(['./x', '../y', '/abs', 'node:fs', 'https://x.test/a.js', 'data:text/javascript,1', '', '@scope'])(
    'maps %s to no package',
    (specifier) => {
      expect(packageNameOf(specifier)).toBeNull();
    },
  );
});
