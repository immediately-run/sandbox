import {
  configure,
  fs,
  mount,
  umount,
  resolveMountConfig,
  InMemory,
  type FileSystem,
} from '@zenfs/core';

import { APP_ROOT } from '../../fsLayout';
import { RegistryFileFetcher } from '../../FileSystem/RegistryFS';

/**
 * R3-48 G0-0 — the booted-bundler integration harness's FOUNDATION (the
 * fixture + loopback-Port plumbing + spies the plan splits out first; the full
 * `bundler.compile()` smoke that also needs a babel-worker loopback is the
 * follow-on piece). It boots an **in-process ZenFS mount table** with:
 *
 *  - a **fake Port for `/app`**: the plan's "InMemory mount stand-in at `/app`" — a
 *    real in-process ZenFS `InMemory` fs mounted at `/app`, standing in for the
 *    parent-hosted Port-backed mount. (The MessageChannel/`attachFS` loopback is the
 *    other option the plan offers; the stand-in is deterministic under jest, where
 *    zenfs's web-`Port` handshake has no transport.)
 *  - a **Port-traffic spy**: a recording proxy over that `/app` backend that records
 *    every fs op routed to it, by `(method, path)`. Accessing `/app` is exactly the
 *    traffic that would cross the Port in production, so a test can assert which
 *    paths did (and did NOT) reach the parent-hosted mount — the §9 "zero Port
 *    traffic for `/node_modules`/`/transpiled` reads" criterion;
 *  - a **network spy**: a `RegistryFileFetcher` that records the lazy unpkg fetches
 *    `RegistryFS` issues for listed-but-not-inlined module files. As of G0-4 the
 *    **Bundler owns the `/node_modules` mount** (it needs the bundler's
 *    `ModuleRegistry`), so this harness no longer mounts `/node_modules` itself — it
 *    only exposes the spy fetcher, which `createBundlerHarness` injects into the
 *    bundler via `setRegistryFetcher` before compile.
 *
 * Every `[harness]` row in `02-zenfs-unification.md` consumes this; it adds no
 * production behavior.
 */

/** A minimal fixture app: enough to exercise transpile + a CSS import + a dep. */
export const FIXTURE_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'harness-fixture', main: 'src/index.tsx', dependencies: { react: '^18.0.0' } }),
  'index.html': '<!doctype html><div id="root"></div>',
  'src/index.tsx': "import App from './App';\nimport './App.css';\nexport default App;\n",
  'src/App.tsx': "export default function App() {\n  return <h1>hello</h1>;\n}\n",
  'src/App.css': 'h1 { color: rebeccapurple; }\n',
};

/** A recorded fs op routed to the `/app` backing (path is mount-relative) — the
 *  in-process stand-in for traffic that crosses the Port in production. */
export interface PortOp {
  method: string;
  path: string;
}

/** A recorded lazy module fetch (the network spy). */
export interface FetchOp {
  module: string;
  version: string;
  relPath: string;
}

// fs methods that carry a path as their first argument — the ones worth recording
// as "Port traffic". Non-path members pass through untouched.
const PATHFUL = new Set<string>([
  'stat', 'read', 'write', 'readdir', 'exists', 'createFile', 'mkdir', 'rename',
  'unlink', 'rm', 'rmdir', 'touch', 'link', 'metadata', 'sync', 'openFile', 'createFileSync',
]);

/** Wrap a `FileSystem` so every path-bearing op is recorded before delegating. */
function recordingFs(backing: FileSystem, record: (op: PortOp) => void): FileSystem {
  return new Proxy(backing, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      if (!PATHFUL.has(prop)) return value.bind(target);
      return (...args: unknown[]) => {
        const path = typeof args[0] === 'string' ? args[0] : '';
        record({ method: prop, path });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as FileSystem;
}

export interface BundlerFsHarness {
  /** Ops the child issued over the `/app` Port (mount-relative paths). */
  portOps: PortOp[];
  /** Lazy module fetches the network spy recorded. */
  fetchOps: FetchOp[];
  /** The network-spy fetcher to inject into the bundler (`setRegistryFetcher`); it
   *  records into `fetchOps` and returns deterministic fetched content. */
  fetcher: RegistryFileFetcher;
  /** Clear both spies (e.g. after seeding, before the assertions). */
  resetSpies(): void;
  /** Tear the `/app` mount down. */
  teardown(): Promise<void>;
}

/**
 * Boot the in-process `/app` mount over a recorded InMemory stand-in (the
 * Port-traffic spy) seeded from `fixture`, plus the network-spy fetcher the
 * bundler-owned `/node_modules` mount consumes. Returns the spies + teardown.
 */
export async function createBundlerFsHarness(
  fixture: Record<string, string> = FIXTURE_APP,
): Promise<BundlerFsHarness> {
  await configure({ disableAccessChecks: true, disableAsyncCache: true });

  const portOps: PortOp[] = [];
  const fetchOps: FetchOp[] = [];

  // --- /app: a recorded InMemory stand-in for the parent-hosted Port mount --
  const appBacking = await resolveMountConfig({ backend: InMemory });
  const recorded = recordingFs(appBacking, (op) => portOps.push(op));
  await fs.promises.mkdir(APP_ROOT).catch(() => undefined); // materialize the mount point
  mount(APP_ROOT, recorded);

  // Seed the fixture THROUGH the Port (writes hit the parent fs); the dir tree is
  // created as needed. Spy is reset afterwards so the read assertions start clean.
  for (const [rel, content] of Object.entries(fixture)) {
    const abs = `${APP_ROOT}/${rel}`;
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => undefined);
    await fs.promises.writeFile(abs, content);
  }

  // --- the network spy: injected into the bundler's RegistryFS via setRegistryFetcher
  const fetcher: RegistryFileFetcher = async (module, version, relPath) => {
    fetchOps.push({ module, version, relPath });
    return `/* fetched ${module}@${version}/${relPath} */`;
  };

  const resetSpies = () => {
    portOps.length = 0;
    fetchOps.length = 0;
  };
  resetSpies(); // drop the seeding writes

  const teardown = async () => {
    try { umount(APP_ROOT); } catch { /* not mounted */ }
  };

  return { portOps, fetchOps, fetcher, resetSpies, teardown };
}
