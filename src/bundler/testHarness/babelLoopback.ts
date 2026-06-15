import type { MessageEndpoint } from '../../utils/WorkerMessageBus';

/**
 * R3-48 G0-0 (compile half) — an in-process loopback for the babel transform.
 *
 * In production the babel worker runs in the PARENT page and hands the iframe a
 * `MessagePort` over a one-time `{ type: 'connect' }` handshake (the iframe has an
 * opaque origin and can't load a same-origin worker). The bundler's
 * `BabelTransformer` then drives that port with `WorkerMessageBus`. Under jest there
 * is no worker and no web `MessageChannel`, so we run the REAL `babel-worker` module
 * in-process: polyfill `self`, import the worker (it registers its module-level
 * `onConnect` listener on `self`), then deliver the connect handshake over a
 * hand-rolled web-style port pair. `@babel/standalone` transpiles directly in node.
 */

interface FakePort extends MessageEndpoint {
  start(): void;
  close(): void;
}

type Listener = (e: { data: unknown }) => void;

/** A web-style loopback `MessagePort` pair (postMessage/addEventListener), passing
 *  messages by reference (in-process — no structured clone needed). Listeners are
 *  keyed by event type so a posted message reaches only `'message'` listeners — NOT
 *  the bus's `'error'` listener (`WorkerMessageBus` registers both). */
function fakeWebPortPair(): { port1: FakePort; port2: FakePort } {
  const a = new Map<string, Set<Listener>>();
  const b = new Map<string, Set<Listener>>();
  const make = (mine: Map<string, Set<Listener>>, theirs: Map<string, Set<Listener>>): FakePort => ({
    postMessage: (msg: unknown) =>
      queueMicrotask(() => theirs.get('message')?.forEach((l) => l({ data: msg }))),
    addEventListener: (type: string, listener: Listener) =>
      (mine.get(type) ?? mine.set(type, new Set()).get(type)!).add(listener),
    removeEventListener: (type: string, listener: Listener) => mine.get(type)?.delete(listener),
    start: () => {},
    close: () => mine.clear(),
  });
  return { port1: make(a, b), port2: make(b, a) };
}

// `self` is polyfilled + the worker imported ONCE per module realm; the worker's
// `onConnect` listener then mints a fresh `bindMessageBus` per connect handshake.
// The worker registers its module-level `onConnect` on `self`; we capture those on a
// dedicated fake `self`, swapped in ONLY around the worker import + handshake and then
// restored (the bundler's other modules read `self` as `globalThis`). The worker's
// `onConnect` self-removes after the first connect, so this is ONE loopback per module
// realm — create it once per test file (`beforeAll`).
const selfListeners = new Set<(e: { data: unknown; ports?: unknown[] }) => void>();
const fakeSelf = {
  addEventListener: (_type: string, listener: (e: { data: unknown; ports?: unknown[] }) => void) =>
    selfListeners.add(listener),
  removeEventListener: (_type: string, listener: (e: { data: unknown; ports?: unknown[] }) => void) =>
    selfListeners.delete(listener),
};
let workerLoaded: Promise<unknown> | null = null;

export interface BabelLoopback {
  /** The endpoint to hand the bundler as its "babel port" (`getBabelPort`). */
  babelPort: MessageEndpoint;
  /**
   * R3-48 Gate 2 (G2-0) — the babel-request spy: the `filepath` of every
   * `transform` request the bundler issued over the loopback, in order. A Gate-2
   * test asserts this is EMPTY for sources served from a seeded `/transpiled`
   * artifact (zero babel-worker transforms, spec §9) and contains exactly the
   * edited file after an HMR edit. Reset with `resetTransformRequests()`.
   */
  transformRequests: string[];
  resetTransformRequests(): void;
  dispose(): void;
}

/** Stand up one in-process babel worker over a loopback port; returns the bundler-side
 *  port. Drive it via `WorkerMessageBus` (as `BabelTransformer` does). */
export async function createBabelLoopback(): Promise<BabelLoopback> {
  const prevSelf = (globalThis as { self?: unknown }).self;
  (globalThis as { self?: unknown }).self = fakeSelf;
  try {
    if (!workerLoaded) workerLoaded = import('../transforms/babel/babel-worker');
    await workerLoaded; // registers the module-level `onConnect` on `fakeSelf`
    const { port1: workerPort, port2: bundlerPort } = fakeWebPortPair();

    // The babel-request spy (G2-0): record the `filepath` of each `transform`
    // request the bundler posts over its port. A `WorkerMessageBus` request is
    // `{ channel, id, method, params }` (WorkerMessageBus.request); the babel
    // `transform` payload is `params[0] = { code, filepath, config }`.
    const transformRequests: string[] = [];
    const rawPost = bundlerPort.postMessage.bind(bundlerPort);
    bundlerPort.postMessage = (msg: unknown, ...rest: unknown[]) => {
      const m = msg as { method?: string; params?: Array<{ filepath?: string }> };
      if (m && m.method === 'transform') {
        transformRequests.push(m.params?.[0]?.filepath ?? '');
      }
      return rawPost(msg, ...rest);
    };

    // The parent's one-time connect handshake: hand the worker its port.
    selfListeners.forEach((listener) => listener({ data: { type: 'connect' }, ports: [workerPort] }));
    return {
      babelPort: bundlerPort,
      transformRequests,
      resetTransformRequests: () => {
        transformRequests.length = 0;
      },
      dispose: () => {
        workerPort.close();
        bundlerPort.close();
      },
    };
  } finally {
    (globalThis as { self?: unknown }).self = prevSelf;
  }
}
