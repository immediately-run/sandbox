import gensync from 'gensync';

import { ModuleNotFoundError } from '../errors/ModuleNotFound';
import { isWithinRoot, resolveSync } from './resolver';

/**
 * R3-772 (BUNDLE_EMBEDDING §4c.3) — the resolver-side root confinement (the
 * snapshot chroot). For a snapshot-mounted program, module resolution is
 * confined to the app root: a `..` escape or an absolute specifier outside it
 * is ENOENT (ModuleNotFoundError), the package.json/tsconfig discovery walks
 * never read above the root, and an in-root package.json alias cannot remap a
 * resolution to outside bytes. The bare-specifier package channel
 * (`node_modules`) is NOT confined — dependency identity is the closure pin's
 * domain — but a package is re-confined to its own subtree once entered.
 *
 * The fixture is an in-memory file map (the shape resolver.test.ts uses), with
 * the hostile content OUTSIDE the confined root at /firestore and /repository —
 * the trees a ZenFS root-bound resolver can otherwise reach.
 */
describe('resolver confinement (confineToRoot)', () => {
  // The in-root manifest carries a hostile alias: a remap of an app path to
  // OUTSIDE bytes — the author-controlled escape the chroot must refuse even
  // though the alias itself is read from inside the root.
  const APP_PACKAGE = JSON.stringify({
    name: 'snapshot-program',
    main: 'src/index.js',
    alias: { '/app/src/missing.js': '/firestore/aliased.js' },
  });
  const files = new Map<string, string>([
    ['/app/package.json', APP_PACKAGE],
    ['/app/src/index.js', "import './util';"],
    ['/app/src/util.js', 'export const ok = true;'],
    ['/app/nested/deep.js', "import '../src/util';"],
    // Host-side trees that must be unreachable from the confined program.
    ['/firestore/x.js', 'export const secret = true;'],
    ['/firestore/aliased.js', 'export const aliased = true;'],
    ['/repository/x.js', 'export const otherRepo = true;'],
    // A root tsconfig whose paths would resolve a bare specifier into the app.
    ['/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '/', paths: { 'tcfg/*': ['/app/src/*'] } } })],
    // The package channel: a CDN/registry-shaped dependency at /node_modules,
    // with one INTERNAL relative import (the common compiled shape).
    ['/node_modules/react/package.json', JSON.stringify({ name: 'react', main: 'index.js' })],
    ['/node_modules/react/index.js', "require('./cjs/react.production.js');"],
    ['/node_modules/react/cjs/react.production.js', 'module.exports = {};'],
    // A second package, to prove cross-package relatives are refused.
    ['/node_modules/leftpad/package.json', JSON.stringify({ name: 'leftpad', main: 'index.js' })],
    ['/node_modules/leftpad/index.js', 'module.exports = () => "";'],
    // A hostile package whose main escapes its own subtree.
    ['/node_modules/evil/package.json', JSON.stringify({ name: 'evil', main: '../../firestore/x.js' })],
    // A prefix-sharing sibling of the confinement root: '/app2' starts with
    // '/app' as a STRING but is not inside it — the walk must never read here.
    ['/app2/package.json', JSON.stringify({ name: 'prefix-sibling' })],
    ['/app2/x.js', 'export const prefixSibling = true;'],
  ]);

  const isFile = gensync({ sync: (p: string) => files.has(p) });
  const reads: string[] = [];
  const readFile = gensync({
    sync: (p: string) => {
      reads.push(p);
      if (!files.has(p)) throw new Error('File not found');
      return files.get(p) as string;
    },
  });

  const base = { extensions: ['.js'], isFile, readFile };
  const CONFINED = { ...base, confineToRoot: '/app' };

  it('a relative escape (../../firestore/x) from the confined root is ENOENT', () => {
    expect(() => resolveSync('../../firestore/x', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      new ModuleNotFoundError('../../firestore/x', '/app/src/index.js'),
    );
  });

  it('an absolute specifier outside the confined root (/repository/x) is ENOENT', () => {
    expect(() => resolveSync('/repository/x', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
  });

  it('control: without the confinement both escapes resolve (the hole the chroot closes)', () => {
    expect(resolveSync('../../firestore/x', { ...base, filename: '/app/src/index.js' })).toBe('/firestore/x.js');
    expect(resolveSync('/repository/x', { ...base, filename: '/app/src/index.js' })).toBe('/repository/x.js');
  });

  it('ordinary in-root resolution is unchanged (relative, nested, absolute-in-root)', () => {
    expect(resolveSync('./util', { ...CONFINED, filename: '/app/src/index.js' })).toBe('/app/src/util.js');
    expect(resolveSync('../src/util', { ...CONFINED, filename: '/app/nested/deep.js' })).toBe('/app/src/util.js');
    expect(resolveSync('/app/src/util', { ...CONFINED, filename: '/app/src/index.js' })).toBe('/app/src/util.js');
  });

  it('an in-root package.json alias cannot remap a resolution to outside bytes', () => {
    // /app/src/missing.js does not exist; the IN-ROOT manifest's alias remaps
    // it to /firestore/aliased.js. Unconfined, the alias fires and the outside
    // bytes load; confined, the outside candidate is never even probed.
    expect(resolveSync('./missing', { ...base, filename: '/app/src/index.js' })).toBe('/firestore/aliased.js');
    expect(() => resolveSync('./missing', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
  });

  it('a root /tsconfig.json paths mapping is not read under confinement', () => {
    expect(resolveSync('tcfg/util', { ...base, filename: '/app/src/index.js' })).toBe('/app/src/util.js');
    expect(() => resolveSync('tcfg/util', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
  });

  it('the package channel still resolves (node_modules is not app content)', () => {
    expect(resolveSync('react', { ...CONFINED, filename: '/app/src/index.js' })).toBe('/node_modules/react/index.js');
  });

  it('a package cannot escape its own subtree (main: ../../firestore/x is ENOENT)', () => {
    expect(() => resolveSync('evil', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(ModuleNotFoundError);
    // Control: unconfined, the same escape resolves — the refusal above is the
    // confinement's doing, not a broken fixture.
    expect(resolveSync('evil', { ...base, filename: '/app/src/index.js' })).toBe('/firestore/x.js');
  });

  it('package INTERNALS resolve within the package subtree under confinement', () => {
    // react's compiled entry requires './cjs/react.production.js' — a confined
    // program's dependencies must keep working (the closure pins them; the
    // chroot is not what pins them).
    expect(resolveSync('./cjs/react.production.js', { ...CONFINED, filename: '/node_modules/react/index.js' })).toBe(
      '/node_modules/react/cjs/react.production.js',
    );
  });

  it('a CROSS-package relative import is refused (the subtree is per-package)', () => {
    expect(() => resolveSync('../leftpad', { ...CONFINED, filename: '/node_modules/react/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
    // Control: unconfined, it resolves.
    expect(resolveSync('../leftpad', { ...base, filename: '/node_modules/react/index.js' })).toBe(
      '/node_modules/leftpad/index.js',
    );
  });

  it('a prefix-sharing sibling of the root (/app2 under /app) is never read', () => {
    reads.length = 0;
    expect(() => resolveSync('../../app2/x', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
    // 3S-7, to the letter: no discovery read touched the outside tree — not
    // even /app2/package.json (the raw-prefix floor would have read it).
    expect(reads.filter((p) => p.startsWith('/app2'))).toEqual([]);
    // Control: unconfined, it resolves (and reads the outside manifest).
    expect(resolveSync('../../app2/x', { ...base, filename: '/app/src/index.js' })).toBe('/app2/x.js');
  });

  it('a trailing-slash root behaves exactly like its normal form', () => {
    reads.length = 0;
    expect(resolveSync('./util', { ...base, confineToRoot: '/app/', filename: '/app/src/index.js' })).toBe(
      '/app/src/util.js',
    );
    // …and the root's own package.json IS still probed (a trailing slash used
    // to floor the walk one level early).
    expect(reads).toContain('/app/package.json');
    expect(() =>
      resolveSync('../../firestore/x', { ...base, confineToRoot: '/app/', filename: '/app/src/index.js' }),
    ).toThrowError(ModuleNotFoundError);
  });

  it('isWithinRoot: containment is on the path boundary, never a raw prefix', () => {
    expect(isWithinRoot('/app', '/app')).toBe(true);
    expect(isWithinRoot('/app', '/app/src/x.js')).toBe(true);
    expect(isWithinRoot('/app', '/app2/x.js')).toBe(false); // the prefix trap
    expect(isWithinRoot('/app', '/firestore/x.js')).toBe(false);
    expect(isWithinRoot('/', '/anything')).toBe(true);
  });
});
