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

// MUST stay the first import: this side-effect module aliases `window` on the worker
// global BEFORE eslint-linter-browserify's process polyfill evaluates (which does a
// bare `window` read that ReferenceErrors in a Worker). worker-window-shim.ts has the
// full mechanism. import-sort keeps side-effect imports ahead of the binding imports.
import './worker-window-shim';

import { FormatRequest, runFormat } from './format';
import { LintRequest, runLint } from './lint';
import { TypecheckRequest, runTypecheck } from './typecheck';
import { createBundledLibHost } from './worker-lib-host';
import { workerLintDeps } from './worker-lint-host';
// `lint` is now worker-safe: `lint.ts` imports neither the Node `eslint` package nor
// `@typescript-eslint/parser` at the top level — both crash a browser Worker on load
// (Node `eslint` calls `url.pathToFileURL`). The browser `Linter`
// (`eslint-linter-browserify`) + parser are injected here via `workerLintDeps`.

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
        // Browser `Linter` + parser injected (workerLintDeps) — no Node build loaded.
        return { id, result: runLint((req.params ?? {}) as LintRequest, workerLintDeps) };
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
