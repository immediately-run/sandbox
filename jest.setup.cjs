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

// TextDecoder/TextEncoder are main-realm globals jest 27 does not copy in either;
// Emscripten-emitted loaders (the R3-426 sql.js fixture) decode wasm strings with them.
if (!globalThis.TextDecoder) {
  const util = require('util');
  globalThis.TextDecoder = util.TextDecoder;
  globalThis.TextEncoder = util.TextEncoder;
}

// Node's WHATWG fetch stack (`fetch`, `Response`, `Request`, `Headers`, `Blob`) lives on
// the MAIN realm's global; jest 27's vm sandbox does not copy it in. The wasm tests
// (R3-426) exercise `fetch(dataUrl)` and `WebAssembly.instantiateStreaming(fetch(...))`,
// so bridge the real classes across: the sandbox's `process` is the main realm's, so its
// Function intrinsic hands back the main-realm global. Same isolate, same-realm brand
// checks — Node's `instantiateStreaming` accepts these `Response` instances (a re-
// implemented polyfill would NOT pass its brand check). Copy-if-missing only, so a
// future jest that ships its own fetch wins.
if (!globalThis.fetch) {
  const realGlobal = process.constructor.constructor('return globalThis')();
  for (const name of ['Response', 'Request', 'Headers', 'Blob', 'FormData']) {
    if (!globalThis[name] && realGlobal[name]) {
      globalThis[name] = realGlobal[name];
    }
  }
  if (realGlobal.fetch) {
    globalThis.fetch = realGlobal.fetch.bind(realGlobal);
  }
}
