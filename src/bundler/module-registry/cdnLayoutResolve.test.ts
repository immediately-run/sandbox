import gensync from 'gensync';

import { resolveSync } from '../../resolver/resolver';
import { NodeModule } from './NodeModule';
import { CDNModuleFileType } from './module-cdn';
import { isFastPathEligible, parseNodeModulePath, resolveFromCdnLayout } from './cdnLayoutResolve';

// The default extension set the bundler passes to resolveAsync (resolver prepends '').
const EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mdx'];

type FileSpec = Record<string, string | number>;

/** Build a registry of NodeModules + the equivalent absolute file map for the real resolver. */
function makeRegistry(pkgs: Record<string, FileSpec>): {
  registry: Map<string, NodeModule>;
  isFile: any;
  readFile: any;
} {
  const registry = new Map<string, NodeModule>();
  const absFiles = new Map<string, string>();
  for (const [pkg, files] of Object.entries(pkgs)) {
    const fileMap: Record<string, CDNModuleFileType> = {};
    for (const [rel, content] of Object.entries(files)) {
      if (typeof content === 'number') {
        // Non-inlined marker (lazily fetched). Present in the map → file exists.
        fileMap[rel] = content;
        absFiles.set(`/node_modules/${pkg}/${rel}`, `/* lazy ${rel} */`);
      } else {
        fileMap[rel] = { c: content, d: [], t: false };
        absFiles.set(`/node_modules/${pkg}/${rel}`, content);
      }
    }
    registry.set(pkg, new NodeModule(pkg, '1.0.0', fileMap, []));
  }
  const isFile = gensync({ sync: (p: string) => absFiles.has(p) });
  const readFile = gensync({
    sync: (p: string) => {
      if (!absFiles.has(p)) throw new Error(`File not found: ${p}`);
      return absFiles.get(p)!;
    },
  });
  return { registry, isFile, readFile };
}

const PKG_JSON = JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' });

describe('parseNodeModulePath', () => {
  it('parses an unscoped package + relative path', () => {
    expect(parseNodeModulePath('/node_modules/react/lib/foo.js')).toEqual({ pkg: 'react', rel: 'lib/foo.js' });
  });
  it('parses a scoped package', () => {
    expect(parseNodeModulePath('/node_modules/@babel/runtime/helpers/x.js')).toEqual({
      pkg: '@babel/runtime',
      rel: 'helpers/x.js',
    });
  });
  it('parses the package root (empty rel)', () => {
    expect(parseNodeModulePath('/node_modules/react')).toEqual({ pkg: 'react', rel: '' });
  });
  it('returns null outside node_modules', () => {
    expect(parseNodeModulePath('/app/src/App.tsx')).toBeNull();
    expect(parseNodeModulePath('/node_modules/')).toBeNull();
  });
});

describe('isFastPathEligible', () => {
  const eligible = (files: FileSpec): boolean => {
    const { registry } = makeRegistry({ pkg: files });
    return isFastPathEligible('pkg', registry.get('pkg')!);
  };

  it('is eligible for a package with only a main entry', () => {
    expect(eligible({ 'package.json': PKG_JSON, 'index.js': 'x' })).toBe(true);
  });
  it('is eligible with no package.json fields at all', () => {
    expect(eligible({ 'package.json': '{"name":"pkg"}', 'index.js': 'x' })).toBe(true);
  });
  it('is INELIGIBLE with a browser-object remap', () => {
    expect(eligible({ 'package.json': JSON.stringify({ main: 'index.js', browser: { './a.js': './b.js' } }), 'index.js': 'x' })).toBe(false);
  });
  it('is INELIGIBLE with an exports subpath map', () => {
    expect(eligible({ 'package.json': JSON.stringify({ exports: { '.': './index.js', './feature': './feature.js' } }), 'index.js': 'x' })).toBe(false);
  });
  it('is INELIGIBLE with an alias field (adds globs)', () => {
    expect(eligible({ 'package.json': JSON.stringify({ alias: { './a': './b' } }), 'index.js': 'x' })).toBe(false);
  });
  it('is INELIGIBLE when package.json is a non-inlined marker', () => {
    expect(eligible({ 'package.json': 1, 'index.js': 'x' })).toBe(false);
  });
  it('is INELIGIBLE when a NESTED package.json carries a remap', () => {
    expect(
      eligible({
        'package.json': PKG_JSON,
        'index.js': 'x',
        'lib/package.json': JSON.stringify({ browser: { './c.js': './d.js' } }),
        'lib/c.js': 'y',
      }),
    ).toBe(false);
  });
});

describe('resolveFromCdnLayout', () => {
  const SIMPLE = {
    pkg: {
      'package.json': PKG_JSON,
      'index.js': 'module.exports = 1',
      'lib/a.js': 'a',
      'lib/b.js': 'b',
      'lib/sub/c.js': 'c',
      'lib/dir/index.js': 'dir-index',
      'data.json': '{}',
    } as FileSpec,
  };

  const run = (specifier: string, filename: string, pkgs = SIMPLE) => {
    const { registry } = makeRegistry(pkgs);
    return resolveFromCdnLayout(specifier, filename, EXTS, registry, new Map());
  };

  it('resolves a relative import by extension', () => {
    expect(run('./lib/a', '/node_modules/pkg/index.js')).toBe('/node_modules/pkg/lib/a.js');
  });
  it('resolves a sibling relative import', () => {
    expect(run('./b', '/node_modules/pkg/lib/a.js')).toBe('/node_modules/pkg/lib/b.js');
  });
  it('resolves a nested relative import', () => {
    expect(run('./sub/c', '/node_modules/pkg/lib/a.js')).toBe('/node_modules/pkg/lib/sub/c.js');
  });
  it('resolves a parent relative import', () => {
    expect(run('../index', '/node_modules/pkg/lib/a.js')).toBe('/node_modules/pkg/index.js');
  });
  it('resolves a directory index', () => {
    expect(run('./dir', '/node_modules/pkg/lib/a.js')).toBe('/node_modules/pkg/lib/dir/index.js');
  });
  it('resolves an exact path including extension', () => {
    expect(run('./b.js', '/node_modules/pkg/lib/a.js')).toBe('/node_modules/pkg/lib/b.js');
    expect(run('../data.json', '/node_modules/pkg/lib/a.js')).toBe('/node_modules/pkg/data.json');
  });

  it('falls through (null) for a bare specifier', () => {
    expect(run('react', '/node_modules/pkg/index.js')).toBeNull();
  });
  it('falls through (null) when the importer is not in node_modules', () => {
    expect(run('./lib/a', '/app/src/App.tsx')).toBeNull();
  });
  it('falls through (null) for an unknown package', () => {
    expect(run('./x', '/node_modules/not-registered/index.js')).toBeNull();
  });
  it('falls through (null) for a missing file', () => {
    expect(run('./nope', '/node_modules/pkg/index.js')).toBeNull();
  });
  it('falls through (null) for an ineligible (aliased) package', () => {
    const pkgs = {
      pkg: { 'package.json': JSON.stringify({ main: 'index.js', browser: { './lib/a.js': './lib/b.js' } }), 'index.js': 'x', 'lib/a.js': 'a', 'lib/b.js': 'b' },
    };
    expect(run('./lib/a', '/node_modules/pkg/index.js', pkgs)).toBeNull();
  });
  it('falls through (null) when a relative import escapes node_modules', () => {
    expect(run('../../app/src/App', '/node_modules/pkg/index.js')).toBeNull();
  });
});

// The strongest guard: whenever the fast path returns a path, it MUST equal what
// the real resolver produces for the same inputs. A disagreement means the fast
// path would silently load the wrong file.
describe('resolveFromCdnLayout ⟺ real resolver equivalence', () => {
  const pkgs = {
    pkg: {
      'package.json': PKG_JSON,
      'index.js': 'i',
      'lib/a.js': 'a',
      'lib/b.jsx': 'b',
      'lib/sub/c.ts': 'c',
      'lib/dir/index.js': 'd',
      'data.json': '{}',
    } as FileSpec,
    // a second package reachable as a (lazily-fetched) file too
    'with-lazy': {
      'package.json': JSON.stringify({ name: 'with-lazy', main: 'main.js' }),
      'main.js': 'm',
      'extra.js': 7, // non-inlined marker — still "exists"
    } as FileSpec,
  };
  const { registry, isFile, readFile } = makeRegistry(pkgs);

  const cases: Array<[string, string]> = [
    ['./lib/a', '/node_modules/pkg/index.js'],
    ['./b', '/node_modules/pkg/lib/a.js'],
    ['./b.jsx', '/node_modules/pkg/lib/a.js'],
    ['./sub/c', '/node_modules/pkg/lib/a.js'],
    ['../index', '/node_modules/pkg/lib/a.js'],
    ['./dir', '/node_modules/pkg/lib/a.js'],
    ['../data.json', '/node_modules/pkg/lib/a.js'],
    ['./extra', '/node_modules/with-lazy/main.js'],
    ['./nope', '/node_modules/pkg/index.js'], // miss → null
  ];

  it.each(cases)('fast(%s from %s) agrees with the resolver', (specifier, filename) => {
    const fast = resolveFromCdnLayout(specifier, filename, EXTS, registry, new Map());
    if (fast === null) return; // deliberate fall-through; the resolver owns it
    let real: string | undefined;
    try {
      real = resolveSync(specifier, { filename, extensions: EXTS, isFile, readFile });
    } catch {
      real = undefined;
    }
    expect(fast).toBe(real);
  });
});
