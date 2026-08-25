/**
 * The realm document's top-level script (roadmap R3-222 Phase 1).
 *
 * Deliberately tiny. Everything with behaviour worth testing lives in `realm-entry.ts`
 * as pure functions, so jest covers it; what is left here is the messaging and the
 * lifecycle of the inner Worker.
 *
 * WHY THE FRAME DOES NOT RUN THE TESTS ITSELF. The Phase-0 drill measured it: a
 * `for(;;)` test body on the frame's own thread wedges the PARENT page, so the host's
 * teardown timer never fires and exit criterion (c) — "a runaway is bounded and the
 * loop survives" — fails. Execution therefore happens in a Worker this frame spawns and
 * can `terminate()` while staying responsive. The Worker inherits the frame's opaque
 * origin and CSP, so it holds exactly the same authority the frame does: none.
 *
 * One request in, one response out, then the host tears the frame down. No standing
 * state, no second call — nothing leaks between two `run_tests` invocations.
 */

import type { RunRequest } from './realm-entry';

interface RealmRequest {
  id: number;
  method: 'run';
  params: RunRequest;
}

/** The frame's own deadline. The HOST has one too, and it is the authority; this is the
 *  inner backstop that keeps the frame able to answer at all, and it is deliberately
 *  shorter so the realm reports a bounded failure instead of being killed silently. */
const WORKER_DEADLINE_MS = 20_000;

window.addEventListener('message', (event: MessageEvent) => {
  const req = event.data as RealmRequest | undefined;
  if (!req || req.method !== 'run' || typeof req.id !== 'number') return;
  // The reply goes back over the port the host opened, never to a `*` target: an
  // opaque-origin frame has no origin to check against, so the PORT is the only
  // authenticated channel available.
  const port = event.ports[0];
  if (!port) return;

  let worker: Worker;
  try {
    worker = new Worker(new URL('./realm-worker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    port.postMessage({ id: req.id, error: `could not start the test worker: ${(e as Error)?.message ?? String(e)}` });
    return;
  }

  let settled = false;
  const finish = (message: Record<string, unknown>): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // `terminate()` is the only real kill against a wedged loop — a cooperative signal
    // is never observed by `for(;;)`.
    worker.terminate();
    port.postMessage(message);
  };

  const timer = setTimeout(
    () => finish({ id: req.id, error: `test run exceeded ${WORKER_DEADLINE_MS}ms and was terminated` }),
    WORKER_DEADLINE_MS,
  );

  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { id?: number; result?: unknown; error?: string } | undefined;
    if (!msg || msg.id !== req.id) return;
    finish(msg.error !== undefined ? { id: req.id, error: msg.error } : { id: req.id, result: msg.result });
  };
  worker.onerror = (ev: ErrorEvent) => finish({ id: req.id, error: ev.message || 'test worker error' });

  worker.postMessage({ id: req.id, params: req.params });
});
