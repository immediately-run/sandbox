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

/** A web-style loopback `MessagePort` pair (postMessage/addEventListener), passing
 *  messages by reference (in-process — no structured clone needed). */
function fakeWebPortPair(): { port1: FakePort; port2: FakePort } {
  const aListeners = new Set<(e: { data: unknown }) => void>();
  const bListeners = new Set<(e: { data: unknown }) => void>();
  const make = (mine: Set<(e: { data: unknown }) => void>, theirs: Set<(e: { data: unknown }) => void>): FakePort => ({
    postMessage: (msg: unknown) => queueMicrotask(() => theirs.forEach((l) => l({ data: msg }))),
    addEventListener: (_type: string, listener: (e: { data: unknown }) => void) => mine.add(listener),
    removeEventListener: (_type: string, listener: (e: { data: unknown }) => void) => mine.delete(listener),
    start: () => {},
    close: () => mine.clear(),
  });
  return { port1: make(aListeners, bListeners), port2: make(bListeners, aListeners) };
}

// `self` is polyfilled + the worker imported ONCE per module realm; the worker's
// `onConnect` listener then mints a fresh `bindMessageBus` per connect handshake.
let selfListeners: Set<(e: { data: unknown; ports?: unknown[] }) => void> | null = null;
let workerLoaded: Promise<unknown> | null = null;

function ensureWorkerLoaded(): Promise<unknown> {
  if (!workerLoaded) {
    selfListeners = new Set();
    (globalThis as { self?: unknown }).self = {
      addEventListener: (_type: string, listener: (e: { data: unknown; ports?: unknown[] }) => void) =>
        selfListeners!.add(listener),
      removeEventListener: (_type: string, listener: (e: { data: unknown; ports?: unknown[] }) => void) =>
        selfListeners!.delete(listener),
    };
    workerLoaded = import('../transforms/babel/babel-worker');
  }
  return workerLoaded;
}

export interface BabelLoopback {
  /** The endpoint to hand the bundler as its "babel port" (`getBabelPort`). */
  babelPort: MessageEndpoint;
  dispose(): void;
}

/** Stand up one in-process babel worker over a loopback port; returns the bundler-side
 *  port. Drive it via `WorkerMessageBus` (as `BabelTransformer` does). */
export async function createBabelLoopback(): Promise<BabelLoopback> {
  await ensureWorkerLoaded();
  const { port1: workerPort, port2: bundlerPort } = fakeWebPortPair();
  // The parent's one-time connect handshake: hand the worker its port.
  selfListeners!.forEach((listener) => listener({ data: { type: 'connect' }, ports: [workerPort] }));
  return {
    babelPort: bundlerPort,
    dispose: () => {
      workerPort.close();
      bundlerPort.close();
    },
  };
}
