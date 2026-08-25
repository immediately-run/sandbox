/**
 * The inner Worker that actually EXECUTES the seeded test modules (roadmap R3-222
 * Phase 1; `plans/in-browser-test-runner/01-execution-realm.mdx`, "Bounding").
 *
 * WHY THIS EXISTS — a measurement, not a preference. The plan offered the inner Worker
 * as an option ("a CPU-bound test *can* be run inside a Worker"). The Phase-0 drill
 * settled it: a `for(;;)` test body running on the realm FRAME's own thread wedges the
 * parent page — the host's teardown timer never fires, and the "loop survives" exit
 * criterion (c) fails. So execution happens here, on a thread the frame can
 * `terminate()` while staying responsive itself.
 *
 * It inherits the frame's opaque origin and its CSP, so it has no more authority than
 * the frame did: no fs handle, no catalog channel, no network.
 */

import { runSeeded, type Evaluator, type RunRequest } from './realm-entry';

/**
 * Evaluate a compiled module as a real ES module via a blob URL.
 *
 * The globals are injected by prepending `const` bindings, because an ES module cannot
 * be handed extra ones. The URL is revoked immediately — a worker that accumulated blob
 * URLs across a large suite would be a slow leak in a context meant to be torn down clean.
 */
const blobModuleEvaluator: Evaluator = async (code, globals) => {
  const names = Object.keys(globals);
  const holder = `__irTestGlobals__${Math.random().toString(36).slice(2)}`;
  (globalThis as unknown as Record<string, unknown>)[holder] = globals;
  const preamble = names
    .map((n) => `const ${n} = globalThis[${JSON.stringify(holder)}][${JSON.stringify(n)}];`)
    .join('\n');
  const url = URL.createObjectURL(new Blob([`${preamble}\n${code}`], { type: 'text/javascript' }));
  try {
    await import(/* webpackIgnore: true */ url);
  } finally {
    URL.revokeObjectURL(url);
    delete (globalThis as unknown as Record<string, unknown>)[holder];
  }
};

self.addEventListener('message', (event: MessageEvent) => {
  const req = event.data as { id: number; params: RunRequest } | undefined;
  if (!req || typeof req.id !== 'number') return;
  void runSeeded(req.params, blobModuleEvaluator)
    .then((result) => self.postMessage({ id: req.id, result }))
    .catch((e: unknown) => self.postMessage({ id: req.id, error: (e as Error)?.message ?? String(e) }));
});
