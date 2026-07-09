import * as logger from '../../../utils/logger';
import { WorkerMessageBus } from '../../../utils/WorkerMessageBus';
import { transformBabel, compileMdx, type ITransformData } from '@immediately-run/transpiler';

// The actual transform (babel presets/plugins + dep collection) now lives in
// @immediately-run/transpiler so the CLI's pre-transpiled artifacts are
// byte-identical to this live transpile (PRETRANSPILED_ARTIFACTS_SPEC §4.4).
// This module keeps only the worker transport: the parent page spawns it and
// bridges a MessagePort to the sandboxed iframe.
//
// R3-149 (SIMPLIFIED_DEPLOYMENT_SPEC §14): the *shipped* same-origin Babel worker
// is no longer built here — it is served by @immediately-run/transpiler's prebuilt
// `worker/` bundle, which site-main vendors into `public/babel-worker/`. So this is
// no longer a Parcel target (the `babelWorker` target + `sync:babel-worker` are
// gone). It is retained, NOT dead: the in-process `babelLoopback` test harness
// (bundler.compile() smoke, spec §9) dynamically imports it, and `./index.ts`
// re-exports its `ITransformData` request shape. The transpiler's worker entry is
// the deployed twin (same `transformBabel`, same channel/handshake).
//
// Re-exported so `BabelTransformer` (./index.ts) keeps importing the request
// shape from here.
export type { ITransformData };

function bindMessageBus(endpoint: MessagePort | Worker | typeof self) {
  // eslint-disable-next-line no-new
  new WorkerMessageBus({
    channel: 'sandpack-babel',
    endpoint,
    handleNotification: () => Promise.resolve(),
    handleRequest: (method, data) => {
      switch (method) {
        case 'transform':
          return transformBabel(data as ITransformData);
        case 'mdx-compile': {
          // R3-150: the MDX→JSX compile runs in the worker now (byte-identical to the
          // in-process chain). Throws `MdxCompileError`; the transport carries line/column.
          const { code, path } = data as { code: string; path: string };
          return compileMdx(code, path);
        }
        default:
          return Promise.reject(new Error('Unknown method'));
      }
    },
    handleError: (err) => {
      logger.error(err);
      return Promise.resolve();
    },
    timeoutMs: 30000,
  });
}

// This worker is created by the *parent* page (not the sandboxed iframe) so the
// iframe can drop `allow-same-origin`. The parent hands us a `MessagePort` that
// is entangled with one transferred into the iframe, so transform requests flow
// directly between the iframe and this worker without the parent relaying them.
// Wait for that one-time `{ type: 'connect' }` handshake, then talk over the
// port instead of `self`.
self.addEventListener('message', function onConnect(evt: MessageEvent) {
  if (evt.data && evt.data.type === 'connect') {
    const port = evt.ports && evt.ports[0];
    if (port) {
      self.removeEventListener('message', onConnect);
      port.start();
      bindMessageBus(port);
    }
  }
});
