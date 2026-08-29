/**
 * R3-411 — the builtin-shim module sources and their paths.
 *
 * A LEAF module on purpose (no imports): `bundler.ts` and the module registry
 * both need the path constant, and a value import from `bundler.ts` would drag
 * the whole zenfs/transpiler chain into every suite that touches the registry
 * (observed: `TextEncoder is not defined` in the lockset tests).
 */

/** Where the unsupported-builtin stub is preloaded. */
export const UNSUPPORTED_BUILTIN_MODULE_PATH = '/node_modules/__node-unsupported/index.js';

/**
 * Source for the sandbox's `crypto` shim. Node's `crypto` is a common guarded
 * require in npm packages (Emscripten builds seed from it; chess/sql style
 * libraries hash with it), and `node:crypto` now resolves here via the `node:`
 * strip. Browser-compatible SUBSET only: `randomBytes` / `randomFillSync` /
 * `getRandomValues` / `webcrypto` (WebCrypto is the one CSPRNG a browser
 * sandbox has). Hashing APIs (`createHash`/`createHmac`/…) are THROW-ON-CALL,
 * not silently wrong: Node's are synchronous and WebCrypto's are not, so a
 * faithful polyfill is impossible here — a package that actually CALLS one
 * gets a named error rather than subtly wrong output.
 */
export const CRYPTO_MODULE_CODE = `
"use strict";

var wc = (typeof self !== "undefined" && self.crypto) ? self.crypto : undefined;
if (!wc || !wc.getRandomValues) {
  throw new Error("crypto shim: this context has no WebCrypto (crypto.getRandomValues)");
}

function randomBytes(size) {
  var bytes = new Uint8Array(size);
  wc.getRandomValues(bytes);
  return bytes;
}

function randomFillSync(buffer, offset, size) {
  offset = offset | 0;
  var view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer || buffer);
  var end = typeof size === "number" ? offset + size : view.length;
  var tmp = new Uint8Array(Math.max(0, end - offset));
  wc.getRandomValues(tmp);
  view.set(tmp, offset);
  return buffer;
}

function unsupported(name) {
  return function () {
    throw new Error(
      "crypto shim: node:crypto '" + name + "' is not available in the browser sandbox " +
      "(WebCrypto covers random only; hashing is synchronous in Node and cannot be polyfilled here)"
    );
  };
}

module.exports = {
  randomBytes: randomBytes,
  randomFillSync: randomFillSync,
  getRandomValues: function (view) { return wc.getRandomValues(view); },
  webcrypto: wc,
  createHash: unsupported("createHash"),
  createHmac: unsupported("createHmac"),
  pbkdf2: unsupported("pbkdf2"),
  scrypt: unsupported("scrypt"),
  generateKeyPairSync: unsupported("generateKeyPairSync"),
  createCipheriv: unsupported("createCipheriv"),
  createDecipheriv: unsupported("createDecipheriv"),
  randomUUID: function () { return (wc.randomUUID ? wc.randomUUID() : undefined); },
};
`.trim();

/**
 * The UNSUPPORTED-BUILTIN stub. A precompiled npm package's guarded
 * `require("node:child_process")` — in a file the app never imports — must not
 * fail the app: resolution of a precompiled package's dependencies never
 * rejects, and lands HERE instead. The stub exports functions that throw only
 * when CALLED, so the failure surfaces exactly when the guarded path actually
 * executes (the item's "fails only if that file is imported" bar).
 */
export const UNSUPPORTED_BUILTIN_MODULE_CODE = `
"use strict";

function unsupported(name) {
  return function () {
    throw new Error(
      "This Node builtin ('" + name + "') is not available in the browser sandbox. " +
      "The requiring module ran a code path that actually called it — the require itself was guarded."
    );
  };
}

module.exports = new Proxy(
  { __immediatelyRunUnsupportedBuiltin: true },
  { get: function (target, prop) { return unsupported(String(prop)); } }
);
`.trim();
