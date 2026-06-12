// Jest's `node` test environment does not expose `globalThis.crypto`. `@zenfs/core`'s
// polyfills assume it exists (`globalThis.crypto.randomUUID ??= ...`), so provide
// Node's Web Crypto implementation before any module loads. Harmless to suites
// that don't use it.
const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
