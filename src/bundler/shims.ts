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
 * Source for the sandbox's `crypto` builtin shim (R3-411). Backed by WebCrypto
 * where an equivalent exists (`randomBytes`/`randomFillSync`/`getRandomValues`/
 * `randomUUID`/`webcrypto`); everything else (`createHash`, `createHmac`, …)
 * is a stub that throws a clear error **only when actually called** — so a
 * package's guarded `require("crypto")`/`require("node:crypto")` (the common
 * Emscripten pattern) loads fine, and only a real use of an unshimmable API
 * fails, with a message naming it.
 *
 * Two properties this shim MUST hold, because a shim that answers WRONGLY is
 * worse than the loud `Cannot find module 'crypto'` it replaced:
 *
 *  1. `randomBytes(n)` returns a Buffer in Node, and the canonical call is
 *     `randomBytes(16).toString('hex')`. A bare `Uint8Array` stringifies as
 *     `"12,45,200,…"` — a silently wrong id/token. So the returned bytes carry a
 *     Node-compatible `toString(encoding)` (hex/base64/utf8/latin1). It is still a
 *     real `Uint8Array` (own property, not a subclass), so `instanceof Uint8Array`,
 *     `.length`, indexing and WebCrypto interop are unchanged. The sandbox ships no
 *     `buffer` shim, so where the app HAS brought its own `Buffer` (globalThis) we
 *     defer to it rather than hand-rolling a second one.
 *  2. `getRandomValues` throws `QuotaExceededError` above 65536 bytes, so every fill
 *     is chunked — `randomBytes(100000)` must work, not throw.
 */
export const CRYPTO_MODULE_CODE = `
"use strict";
var webcrypto = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
var NativeBuffer = (typeof globalThis !== "undefined" && globalThis.Buffer) || null;
// getRandomValues rejects any view longer than this (QuotaExceededError), so fills
// are chunked rather than passed whole.
var RANDOM_CHUNK = 65536;
function requireWebCrypto(api) {
  if (!webcrypto) {
    throw new Error("[sandpack] crypto." + api + " is unavailable: WebCrypto (globalThis.crypto) is missing");
  }
  return webcrypto;
}
function fillRandom(api, u8) {
  var api_ = requireWebCrypto(api);
  for (var off = 0; off < u8.length; off += RANDOM_CHUNK) {
    api_.getRandomValues(u8.subarray(off, Math.min(off + RANDOM_CHUNK, u8.length)));
  }
  return u8;
}
// Node's Buffer#toString for the encodings a randomBytes() caller actually uses.
function bytesToString(u8, encoding) {
  var enc = String(encoding == null ? "utf8" : encoding).toLowerCase();
  var i;
  if (enc === "hex") {
    var hex = "";
    for (i = 0; i < u8.length; i++) hex += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    return hex;
  }
  if (enc === "base64" || enc === "latin1" || enc === "binary" || enc === "ascii") {
    var bin = "";
    for (i = 0; i < u8.length; i++) bin += String.fromCharCode(enc === "ascii" ? u8[i] & 0x7f : u8[i]);
    if (enc !== "base64") return bin;
    if (typeof btoa !== "function") {
      throw new Error("[sandpack] crypto: base64 encoding is unavailable (btoa is missing)");
    }
    return btoa(bin);
  }
  if (enc === "utf8" || enc === "utf-8") {
    if (typeof TextDecoder !== "function") {
      throw new Error("[sandpack] crypto: utf8 decoding is unavailable (TextDecoder is missing)");
    }
    return new TextDecoder().decode(u8);
  }
  throw new Error("[sandpack] crypto: unsupported encoding '" + encoding + "' (hex/base64/utf8/latin1 only)");
}
// Give the bytes Node's Buffer#toString without changing what they ARE: a real
// Uint8Array with one non-enumerable own method. Defer to a real Buffer when the
// app supplies one.
function asBuffer(u8) {
  if (NativeBuffer && typeof NativeBuffer.from === "function") {
    return NativeBuffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  Object.defineProperty(u8, "toString", {
    value: function (encoding) {
      return bytesToString(this, encoding);
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return u8;
}
function randomFillSync(buffer, offset, size) {
  var u8 =
    buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
  var start = offset || 0;
  var end = size == null ? u8.length : start + size;
  fillRandom("randomFillSync", u8.subarray(start, end));
  return buffer;
}
function randomBytes(size, cb) {
  var bytes = asBuffer(fillRandom("randomBytes", new Uint8Array(size)));
  if (typeof cb === "function") {
    cb(null, bytes);
    return;
  }
  return bytes;
}
function unsupported(name) {
  return function () {
    throw new Error(
      "[sandpack] crypto." + name + " is not supported in the browser sandbox; use crypto.subtle (WebCrypto) instead"
    );
  };
}
module.exports = {
  webcrypto: webcrypto,
  subtle: webcrypto ? webcrypto.subtle : undefined,
  getRandomValues: function (arr) {
    return requireWebCrypto("getRandomValues").getRandomValues(arr);
  },
  randomUUID: function () {
    return requireWebCrypto("randomUUID").randomUUID();
  },
  randomBytes: randomBytes,
  pseudoRandomBytes: randomBytes,
  randomFillSync: randomFillSync,
  randomFill: function (buffer) {
    var cb = arguments[arguments.length - 1];
    var offset = arguments.length > 2 ? arguments[1] : undefined;
    var size = arguments.length > 3 ? arguments[2] : undefined;
    try {
      cb(null, randomFillSync(buffer, offset, size));
    } catch (err) {
      cb(err);
    }
  },
  createHash: unsupported("createHash"),
  createHmac: unsupported("createHmac"),
  createSign: unsupported("createSign"),
  createVerify: unsupported("createVerify"),
  createCipheriv: unsupported("createCipheriv"),
  createDecipheriv: unsupported("createDecipheriv"),
  pbkdf2: unsupported("pbkdf2"),
  pbkdf2Sync: unsupported("pbkdf2Sync"),
  scrypt: unsupported("scrypt"),
  scryptSync: unsupported("scryptSync"),
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
