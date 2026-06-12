// Jest 27's default resolver does not honor a package's `exports` field, so
// modern exports-only subpaths (e.g. `kerium/log`, `utilium/requests`, pulled in
// transitively by `@zenfs/core`) fail to resolve. This resolver tries the
// default first and, only on failure, falls back to `exports`-field resolution
// for bare package imports. Transforming those ESM dist files is already handled
// by `transformIgnorePatterns: []` in jest.config.js.
const fs = require('fs');
const path = require('path');
const { resolve: resolveExports } = require('resolve.exports');

// Locate a package's package.json by walking `node_modules` upward. We can't use
// `require.resolve('<pkg>/package.json')` because exports-only packages (e.g.
// kerium) don't export `./package.json`, so that lookup fails.
function findPackageJson(pkgName, basedir) {
  let dir = basedir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkgName, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

module.exports = (request, options) => {
  const { defaultResolver, basedir } = options;
  try {
    return defaultResolver(request, options);
  } catch (err) {
    // Only bare package specifiers have an `exports` map to consult.
    if (request.startsWith('.') || path.isAbsolute(request)) throw err;

    const parts = request.split('/');
    const pkgName = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];

    const pkgJsonPath = findPackageJson(pkgName, basedir);
    if (!pkgJsonPath) throw err;

    let target;
    try {
      target = resolveExports(require(pkgJsonPath), request, {
        conditions: ['node', 'import', 'require', 'default'],
        browser: false,
      });
    } catch {
      throw err;
    }
    if (!target) throw err;

    const relative = Array.isArray(target) ? target[0] : target;
    return path.join(path.dirname(pkgJsonPath), relative);
  }
};
