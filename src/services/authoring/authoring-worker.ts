// The authoring worker entry (CLIENT_SERVICES_SPEC §6, authoring-services plan
// Phase 0/1). A SAME-ORIGIN worker the host's ServiceHost spawns and talks to
// DIRECTLY over `self` (parent ⇄ worker) — unlike the Babel worker it is not
// bridged into the opaque-origin iframe, because the host calls it on behalf of an
// app through the gated catalog (§5.5), not the app itself.
//
// Transport mirrors the WorkerMessageBus wire shape ServiceHost expects:
//   request  { id, method, params }   →   response { id, result } | { id, error }
//
// It runs kernel-reviewed code under host authority; the only methods are the
// fixed `format`/`typecheck` (no caller-supplied code/config — CS-1).

import { runFormat, type FormatRequest } from './format';
import { runTypecheck, type TypecheckRequest } from './typecheck';
import { createBundledLibHost } from './worker-lib-host';
// NOTE: `lint` is intentionally NOT imported here. `./lint` statically imports the
// Node `eslint` package (via `@eslint/eslintrc`, which calls `createRequire`/
// `url.pathToFileURL` at init) — pulling it into the worker bundle crashes the whole
// worker on load in a browser (no `pathToFileURL`). `format` + `typecheck` don't
// need eslint and work today; wiring `lint` to `eslint-linter-browserify` + a
// browser-safe TS parser is the remaining Phase-2 step (CLIENT_SERVICES_STATUS).

interface WireRequest {
  id?: number;
  method?: string;
  params?: unknown;
}

export function handleMessage(req: WireRequest): { id: number; result?: unknown; error?: string } {
  const id = typeof req.id === 'number' ? req.id : -1;
  try {
    switch (req.method) {
      case 'format':
        return { id, result: runFormat((req.params ?? {}) as FormatRequest) };
      case 'typecheck':
        // Serve the standard lib from the build-time bundle (no fs in a Worker).
        return {
          id,
          result: runTypecheck((req.params ?? {}) as TypecheckRequest, {
            createBaseHost: createBundledLibHost,
          }),
        };
      case 'lint':
        // Phase-2 pending: needs eslint-linter-browserify (the Node `eslint` build
        // can't run in a browser worker). A clean error, never a crash.
        return { id, error: 'lint is not yet available in the worker runtime' };
      default:
        return { id, error: `unknown method ${JSON.stringify(req.method)}` };
    }
  } catch (e) {
    return { id, error: (e as Error)?.message ?? String(e) };
  }
}

// Wire it to the worker global. Guarded so importing this module in a test (no
// worker `self`/addEventListener) is inert.
declare const self: {
  addEventListener?: (type: 'message', cb: (ev: MessageEvent) => void) => void;
  postMessage?: (msg: unknown) => void;
};

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (ev: MessageEvent) => {
    const res = handleMessage((ev.data ?? {}) as WireRequest);
    self.postMessage?.(res);
  });
}
