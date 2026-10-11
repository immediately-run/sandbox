import gensync from 'gensync';

import { ModuleNotFoundError } from '../errors/ModuleNotFound';
import * as pathUtils from '../utils/path';
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
  // The in-root manifest carries two hostile aliases: a remap of an app path
  // to OUTSIDE bytes — and the same remap spelled through a dot-dot that stays
  // '/app/'-prefixed as a STRING. Both are the author-controlled escapes the
  // chroot must refuse even though the alias is read from inside the root.
  const APP_PACKAGE = JSON.stringify({
    name: 'snapshot-program',
    main: 'src/index.js',
    alias: {
      '/app/src/missing.js': '/firestore/aliased.js',
      '/app/src/dotdot.js': '/app/../firestore/aliased.js',
    },
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
    // A package whose entry is NOT <root>/index.js — its main remap lives in
    // the package's own manifest and must still apply under confinement.
    ['/node_modules/foo/package.json', JSON.stringify({ name: 'foo', main: 'lib/main.js' })],
    ['/node_modules/foo/lib/main.js', 'module.exports = "foo";'],
    // A package with a browser-field remap, in-package (applies) — and one
    // package whose browser field remaps OUT of the package (refused).
    [
      '/node_modules/br/package.json',
      JSON.stringify({ name: 'br', main: 'server.js', browser: { './server.js': './browser.js' } }),
    ],
    ['/node_modules/br/server.js', 'module.exports = "server";'],
    ['/node_modules/br/browser.js', 'module.exports = "browser";'],
    [
      '/node_modules/brout/package.json',
      JSON.stringify({ name: 'brout', main: 'index.js', browser: { './index.js': '/firestore/x.js' } }),
    ],
    ['/node_modules/brout/index.js', 'module.exports = "index";'],
    // A prefix-sharing sibling of the confinement root: '/app2' starts with
    // '/app' as a STRING but is not inside it — the walk must never read here.
    ['/app2/package.json', JSON.stringify({ name: 'prefix-sibling' })],
    ['/app2/x.js', 'export const prefixSibling = true;'],
  ]);

  // The map keys are canonical; the FS underneath the resolver (ZenFS)
  // resolves dot segments, so the double normalizes on lookup — as the real
  // filesystem does — while the read spy records the RAW probed spelling.
  const isFile = gensync({ sync: (p: string) => files.has(pathUtils.normalize(p)) });
  const reads: string[] = [];
  const readFile = gensync({
    sync: (p: string) => {
      reads.push(p);
      const key = pathUtils.normalize(p);
      if (!files.has(key)) throw new Error('File not found');
      return files.get(key) as string;
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

  it('a package whose entry is not <root>/index.js still resolves (its own main remap applies)', () => {
    // The discovery walk for a package's internals floors at the PACKAGE's
    // root, so its manifest — and its main field — are read as unconfined.
    expect(resolveSync('foo', { ...CONFINED, filename: '/app/src/index.js' })).toBe('/node_modules/foo/lib/main.js');
    expect(resolveSync('foo', { ...base, filename: '/app/src/index.js' })).toBe('/node_modules/foo/lib/main.js');
  });

  it('a package browser-field remap applies in-package, and cannot remap out of it', () => {
    expect(resolveSync('br', { ...CONFINED, filename: '/app/src/index.js' })).toBe('/node_modules/br/browser.js');
    // The escape variant: brout's browser field points at /firestore — refused
    // (the alias remap lands outside the package's confinement subtree).
    expect(() => resolveSync('brout', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
    // Control: unconfined, brout's escape resolves.
    expect(resolveSync('brout', { ...base, filename: '/app/src/index.js' })).toBe('/firestore/x.js');
  });

  it('a dot-dot-bearing ABSOLUTE spelling (/app/../firestore/x) is ENOENT — containment never reads unnormalized strings', () => {
    // The item's Architecture rule, directly: the containment check must not be
    // a string-prefix test on an unnormalized path. resolveFile returns a
    // '/'-leading specifier verbatim, so this spelling reaches the check with
    // its '..' intact.
    expect(() => resolveSync('/app/../firestore/x', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
    // …and the same spelling INSIDE the root still resolves (normalization is
    // not a refusal of legal paths). The resolver returns the probed spelling
    // verbatim — its standing contract; the FS canonicalizes underneath.
    expect(resolveSync('/app/src/../src/util', { ...CONFINED, filename: '/app/src/index.js' })).toBe(
      '/app/src/../src/util.js',
    );
  });

  it('a dot-dot-bearing ALIAS value (/app/../firestore/…) cannot escape either', () => {
    // The in-root manifest remaps an app path to a dot-dot spelling of outside
    // bytes; the probe-side check normalizes before comparing.
    expect(() => resolveSync('./dotdot', { ...CONFINED, filename: '/app/src/index.js' })).toThrowError(
      ModuleNotFoundError,
    );
    // Control: unconfined, the alias fires (the resolver returns the probed
    // spelling verbatim — its standing contract; the FS canonicalizes).
    expect(resolveSync('./dotdot', { ...base, filename: '/app/src/index.js' })).toBe('/app/../firestore/aliased.js');
  });

  it('isWithinRoot: containment is on the path boundary, never a raw prefix', () => {
    expect(isWithinRoot('/app', '/app')).toBe(true);
    expect(isWithinRoot('/app', '/app/src/x.js')).toBe(true);
    expect(isWithinRoot('/app', '/app2/x.js')).toBe(false); // the prefix trap
    expect(isWithinRoot('/app', '/firestore/x.js')).toBe(false);
    expect(isWithinRoot('/', '/anything')).toBe(true);
  });
});
