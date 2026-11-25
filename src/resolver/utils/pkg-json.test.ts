import fs from 'fs';
import path from 'path';

import { processPackageJSON } from './pkg-json';

const FIXTURE_PATH = path.join(__dirname, '../fixture');

describe('process package.json', () => {
  it('Should correctly process pkg.exports from @babel/runtime', () => {
    const content = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_PATH, 'node_modules/@babel/runtime/package.json'), 'utf-8'),
    );
    const processedPkg = processPackageJSON(content, '/node_modules/@babel/runtime');
    expect(processedPkg).toMatchSnapshot();
  });

  it('Should correctly handle nested pkg#exports fields (solid-js)', () => {
    const content = JSON.parse(fs.readFileSync(path.join(FIXTURE_PATH, 'node_modules/solid-js/package.json'), 'utf-8'));
    const processedPkg = processPackageJSON(content, '/node_modules/solid-js');
    expect(processedPkg).toMatchSnapshot();
  });

  it('Should correctly handle root pkg.json', () => {
    const content = JSON.parse(fs.readFileSync(path.join(FIXTURE_PATH, 'package.json'), 'utf-8'));
    const processedPkg = processPackageJSON(content, '/');
    expect(processedPkg).toMatchSnapshot();
  });

  it('R3-1384: a package mapped to false in browser sends its subpaths to the empty shim too', () => {
    const { aliases } = processPackageJSON(
      { browser: { 'csv-parse': false, '@scope/cli': false, './src/node.js': false, other: './other.js' } },
      '/app',
    );
    expect(aliases['csv-parse']).toBe('/empty.js');
    expect(aliases['csv-parse/**']).toBe('/empty.js');
    expect(aliases['@scope/cli/**']).toBe('/empty.js');
    // A path key names one file, and a string mapping is an alias: neither gets a wildcard.
    expect(aliases['/app/src/node.js']).toBe('/empty.js');
    expect(Object.keys(aliases).filter((k) => k.includes('*'))).toEqual(['csv-parse/**', '@scope/cli/**']);
  });

  it("R3-1384: a dependency's own browser:false keeps the exact-specifier meaning (no wildcard)", () => {
    const { aliases } = processPackageJSON({ browser: { util: false } }, '/node_modules/readable-stream');
    expect(aliases.util).toBe('/empty.js');
    expect(aliases['util/**']).toBeUndefined();
  });

  it('R3-1384: a mounted library or a nested package.json is not the root (no wildcard)', () => {
    for (const pkgRoot of ['/mnt/0123456789abcdef0123456789abcdef', '/app/packages/web']) {
      const { aliases } = processPackageJSON({ browser: { util: false } }, pkgRoot);
      expect(aliases.util).toBe('/empty.js');
      expect(Object.keys(aliases).filter((k) => k.includes('*'))).toEqual([]);
    }
  });
});
