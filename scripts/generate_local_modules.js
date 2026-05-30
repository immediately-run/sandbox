// Regenerates src/config/local_modules.json from the vendored SDK files.
// Run AFTER scripts/copy-sdk.sh has populated static/tinkerable-sdk/:
//   node scripts/generate_local_modules.js > src/config/local_modules.json
const path = require('path')
const glob = require('glob')

const rootdir = path.join(
    __dirname,
    '..')

const baseDir = path.join(rootdir, 'static/tinkerable-sdk')

const files = glob.sync(path.join(baseDir, '**'))

const urls = Object.fromEntries(
        files.sort()
            .map(f => path.relative(baseDir, f))
            .filter(rel => rel.endsWith('.js'))
            .map(rel => [rel, `/tinkerable-sdk/${rel}`])
        )

console.log(
    JSON.stringify({
  "modules": {
    "@tinkerable/sdk": {
      "urls": {
        ...urls,
        "package.json": "/tinkerable-sdk/package.json",
      }
    }
  }
}, null, 2));
