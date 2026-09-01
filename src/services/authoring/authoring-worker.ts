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
// fixed `format`/`typecheck`/`lint` (no caller-supplied code/config — CS-1).
//
// ── A CHUNK PER METHOD (R3-330) ──────────────────────────────────────────────
// The engines are DYNAMICALLY imported, so the entry is a thin dispatcher and
// each engine arrives on first use of THAT method: `format` — a string-to-string
// transform that needs prettier alone — no longer pays for the TypeScript
// compiler, the linter and ~2.5 MB of lib text in one monolithic fetch (the
// monolith measured 10.65 MB raw / 2.43 MB gzipped on 2026-09-01). Parcel emits
// each dynamically-imported module as its own hashed async chunk, resolved
// relative to the worker URL under the same-origin /authoring-worker/ directory;
// sync-authoring-worker.sh copies them alongside the entry. The lib text rides
// its own chunk (worker-lib-host is dynamically imported, and only typecheck
// asks for it), so it is separately cacheable and separately skipped.
//
// The per-call timeout / terminate backstop / input budget all live in the
// host's ServiceHost, which is untouched: this is a packaging change, not a
// trust-boundary change. A chunk that fails to load surfaces as the method's
// ordinary error path ({ id, error }), and the next call retries — the host's
// respawn-on-error behaviour needs nothing new here.

// MUST stay the first import: this side-effect module aliases `window` on the worker
// global BEFORE eslint-linter-browserify's process polyfill evaluates (which does a
// bare `window` read that ReferenceErrors in a Worker). worker-window-shim.ts has the
// full mechanism. It stays in the ENTRY (a few hundred bytes, zero dependencies):
// the entry always evaluates before any chunk, so the guarantee holds no matter which
// engine's chunk loads the polyfill.
import './worker-window-shim';

import type { FormatRequest } from './format';
import type { LintRequest } from './lint';
import type { TypecheckRequest } from './typecheck';

interface WireRequest {
  id?: number;
  method?: string;
  params?: unknown;
}

export type WireResponse = { id: number; result?: unknown; error?: string };

export async function handleMessage(req: WireRequest): Promise<WireResponse> {
  const id = typeof req.id === 'number' ? req.id : -1;
  try {
    switch (req.method) {
      case 'format': {
        const { runFormat } = await import('./format');
        return { id, result: runFormat((req.params ?? {}) as FormatRequest) };
      }
      case 'typecheck': {
        // Serve the standard lib from the build-time bundle (no fs in a Worker).
        // The lib host — and the ~2.5 MB of `lib.*.d.ts` text it carries — is its
        // own chunk, fetched with the compiler and never by the other methods.
        const [{ runTypecheck }, { createBundledLibHost }] = await Promise.all([
          import('./typecheck'),
          import('./worker-lib-host'),
        ]);
        return {
          id,
          result: runTypecheck((req.params ?? {}) as TypecheckRequest, {
            createBaseHost: createBundledLibHost,
          }),
        };
      }
      case 'lint': {
        // Browser `Linter` (`eslint-linter-browserify`) + parser injected via
        // `workerLintDeps` — no Node build loaded, and the linter's mass stays in
        // the lint chunk. The window shim (entry, first import) has aliased
        // `window` before this chunk's process polyfill evaluates.
        const [{ runLint }, { workerLintDeps }] = await Promise.all([import('./lint'), import('./worker-lint-host')]);
        return { id, result: runLint((req.params ?? {}) as LintRequest, workerLintDeps) };
      }
      default:
        return { id, error: `unknown method ${JSON.stringify(req.method)}` };
    }
  } catch (e) {
    return { id, error: (e as Error)?.message ?? String(e) };
  }
}

// Wire it to the worker global. Guarded so importing this module in a test (no
// worker `self`/addEventListener) is inert. Async: the dispatcher awaits its
// engine chunk before replying, and errors (including a chunk that fails to
// load) resolve as the call's own { id, error } response.
declare const self: {
  addEventListener?: (type: 'message', cb: (ev: MessageEvent) => void) => void;
  postMessage?: (msg: unknown) => void;
};

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (ev: MessageEvent) => {
    void handleMessage((ev.data ?? {}) as WireRequest).then((res) => {
      self.postMessage?.(res);
    });
  });
}
