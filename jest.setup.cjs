// Jest's `node` test environment does not expose some globals that `@zenfs/core`
// and its deps assume exist. Provide them before any module loads. Harmless to
// suites that don't use them.
const { webcrypto } = require('crypto');
const v8 = require('v8');

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}
if (!globalThis.structuredClone) {
  // Sufficient for the plain config/context objects zenfs clones.
  globalThis.structuredClone = (value) => v8.deserialize(v8.serialize(value));
}
