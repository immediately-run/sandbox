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
import { runLint, type LintRequest } from './lint';

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
        return { id, result: runTypecheck((req.params ?? {}) as TypecheckRequest) };
      case 'lint':
        return { id, result: runLint((req.params ?? {}) as LintRequest) };
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
