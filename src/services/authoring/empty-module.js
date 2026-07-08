// Empty stub aliased in for `globby` (see the `alias` block in package.json).
//
// `@typescript-eslint/parser`'s `typescript-estree` engine only `require()`s globby
// on its PROJECT / type-aware path (`resolveProjectList.js` → `globby.sync(...)`),
// which the authoring lint service NEVER takes: CS-1 forbids caller-supplied project
// config, so `parserOptions.project` is never set. Bundling the real globby drags in
// `fast-glob` → `@nodelib/fs.scandir`, whose module-init evaluates
// `process.versions.node.split('.')` — and the browser `process` polyfill has an
// empty `versions`, so that crashes the whole Worker at load. Aliasing globby to this
// empty module drops the entire node-only subtree from the worker bundle. Safe
// because the only code that would touch `globby.sync` is unreachable here.
module.exports = {};
