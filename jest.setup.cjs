// Jest's `node` test environment does not expose `globalThis.crypto`. `@zenfs/core`'s
// polyfills assume it exists (`globalThis.crypto.randomUUID ??= ...`), so provide
// Node's Web Crypto implementation before any module loads. Harmless to suites
// that don't use it.
const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// Several bundler modules read the browser `self` global at module-load time
// (e.g. `src/bundler/module/eval.ts`: `typeof window === 'undefined' ? self : window`).
// The `node` test env has no `self`, so point it at `globalThis` before any module
// loads. (The babel loopback temporarily swaps `self` for its worker handshake and
// restores it.)
if (!globalThis.self) {
  globalThis.self = globalThis;
}

// `bindContext` (zenfs `createChildContext`) clones its context descriptor with
// `structuredClone`, which the jest node env doesn't expose. A v8 round-trip covers
// the plain data it clones.
if (!globalThis.structuredClone) {
  const v8 = require('v8');
  globalThis.structuredClone = (value) => v8.deserialize(v8.serialize(value));
}
