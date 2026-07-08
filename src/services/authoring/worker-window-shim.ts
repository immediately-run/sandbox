// MUST be the FIRST import in `authoring-worker.ts`.
//
// `eslint-linter-browserify` bundles a Node `process` polyfill (pulled in by its
// `debug` dependency) whose browserify wrapper runs, at module-evaluation time:
//     (window || globalThis).process = function () { … }
// That is a BARE `window` read. In a browser main thread `window` exists; in a
// Worker it does not, so the read throws `ReferenceError: window is not defined`
// BEFORE the `|| globalThis` can short-circuit (an undeclared identifier throws; it
// is not merely `undefined`). The whole worker then fails to load.
//
// Aliasing `window` to the worker global fixes it: a bare `window` reference then
// resolves to this global property instead of throwing, and `.process` lands on the
// worker global as intended. This side effect must run before
// `eslint-linter-browserify` is evaluated — hence "first import". (`self.window` is
// a plain property access, which is safe — it returns `undefined`, it does not throw
// the way a bare `window` identifier read does.)

declare const self: Record<string, unknown> & { window?: unknown };

if (typeof self !== 'undefined' && typeof self.window === 'undefined') {
  self.window = self;
}

export {};
