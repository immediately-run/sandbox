#!/usr/bin/env node
/*
 * Does an app pinned to the PREVIOUS PUBLISHED SDK still speak a wire this frame
 * understands? (PLATFORM_LAYERING_SPEC §2 / S1, R3-274d exit criterion "compat
 * proven, not assumed".)
 *
 * The risk this closes is the one the protocol snapshot cannot see on its own: the
 * snapshot compares this repo against ITSELF over time, so a wire name that the
 * frame renames in lockstep with its own snapshot looks clean here and breaks every
 * app already pinned to an older SDK — which is most apps, forever
 * (SDK_PACKAGING_SPEC §9, core value 4: a fork rides its pinned SDK).
 *
 * WHY IT DRIVES THE REAL PACKAGE. A check that re-implements both sides only proves
 * two transcriptions agree with each other; the SDK's own codegen `verify.mjs` was
 * green for four weeks while describing a `shareSpace()` that never existed. So this
 * downloads the published tarball, loads its BUILT dist in node, and records what
 * that code actually puts on the wire through a transport spy.
 *
 * Two mechanics make that possible (both cheap, both non-obvious):
 *   1. tsup emits extensionless relative specifiers (`./sandboxUtils`); node's ESM
 *      resolver rejects them. `registerHooks` bridges it in-process.
 *   2. The transport resolves LAZILY inside each call, so importing is safe — only
 *      calling needs `globalThis.__immediatelyRun__` (SDK_PACKAGING_SPEC §4).
 *
 * Run: node scripts/check-sdk-compat.mjs [--version <npm version>] [--self-test]
 *      (default: the `latest` dist-tag — the version an app pinning today gets)
 *
 * NOT in `npm run verify`: it reaches the npm registry. Run it when the wire changes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** Every wire name this frame's vocabulary knows — its own plus the SDK-side names
 *  it RELAYS (the frame forwards them; the host is the other end). */
const knownNames = () => {
  const frame = JSON.parse(readFileSync(join(root, 'protocol-snapshot.json'), 'utf8'));
  const sdk = JSON.parse(readFileSync(join(root, 'generated/sdk/protocol-snapshot.json'), 'utf8'));
  return {
    frame: new Set(Object.keys(frame.channels)),
    all: new Set([...Object.keys(frame.channels), ...Object.keys(sdk.channels)]),
  };
};

/** Download + extract the published SDK; returns its package root. */
const fetchPublished = (version) => {
  const tmp = mkdtempSync(join(tmpdir(), 'ir-sdk-compat-'));
  execFileSync('npm', ['pack', `@immediately-run/sdk@${version}`, '--silent'], {
    cwd: tmp,
    stdio: 'pipe',
  });
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', tgz], { cwd: tmp, stdio: 'pipe' });
  return { dir: join(tmp, 'package'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
};

// Two resolutions the extracted tarball cannot do on its own:
//   - tsup's extensionless relative specifiers (`./sandboxUtils`) → the real file;
//   - the SDK's PEER deps (`react`), which a bare `npm pack` extract has no
//     node_modules for. They resolve against THIS repo's install — no sibling
//     checkout, which is the coupling R3-274d exists to remove.
const PEERS = new Set(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[cm]?js$/.test(spec) && ctx.parentURL) {
      const p = fileURLToPath(new URL(spec, ctx.parentURL)) + '.js';
      if (existsSync(p)) return { url: pathToFileURL(p).href, shortCircuit: true };
    }
    if (PEERS.has(spec) || spec.startsWith('react/') || spec.startsWith('react-dom/')) {
      return next(spec, { ...ctx, parentURL: pathToFileURL(join(root, 'noop.js')).href });
    }
    return next(spec, ctx);
  },
});

/**
 * Drive the built SDK against a spying transport and return every wire name it
 * actually exchanged — OBSERVED, never asserted from a list. A name only counts as
 * "listened for" when delivering it produced a visible EFFECT in the published
 * code (the catalog updated, the fs listener fired, the handshake was re-sent).
 * Listing the names we hoped it would handle would be the "re-implements both
 * sides" failure this whole check exists to avoid.
 */
const observe = async (pkgDir) => {
  const sent = [];
  const requested = new Set();
  const listeners = [];

  globalThis.__immediatelyRun__ = {
    transport: {
      sendMessage(type) {
        sent.push(type);
      },
      onMessage(handler) {
        listeners.push(handler);
        return { dispose() {} };
      },
      async protocolRequest(scheme, method) {
        requested.add(`protocol-${scheme}`);
        // The `{ok, data}` envelope every gated method answers with, so the SDK's
        // wrappers unwrap instead of throwing — we are proving the CALL, not the
        // payload.
        return { ok: true, data: method === 'list' ? [] : {} };
      },
    },
  };

  const load = (rel) => import(pathToFileURL(join(pkgDir, 'dist', rel)).href);
  const deliver = (msg) => listeners.forEach((h) => h(msg));
  const exchanged = new Set();
  const failures = [];
  const check = (name, ok, detail) => {
    if (ok) exchanged.add(name);
    else failures.push(`${name}: ${detail}`);
  };

  // --- handshake -------------------------------------------------------------
  const runtime = await load('runtime.js');
  runtime.announceHandshake();
  check('sdk-handshake', sent.includes('sdk-handshake'), 'the SDK never announced itself');

  const before = sent.length;
  deliver({ type: 'request-handshake' });
  check(
    'request-handshake',
    sent.length > before && sent[sent.length - 1] === 'sdk-handshake',
    'the SDK did not re-announce when the frame asked',
  );

  // The additive field under test: delivering the frame's NEW handshake shape must
  // not disturb an SDK that has never heard of it.
  deliver({ type: 'sdk-handshake', protocolVersion: '1.0.0', sandboxProtocolVersion: '1.0.0' });

  // --- a `protocol-*` round-trip (the mount family) ---------------------------
  const mounts = await load('mounts.js');
  const spaces = await mounts.listSpaces();
  check(
    'protocol-spaces',
    requested.has('protocol-spaces') && Array.isArray(spaces),
    'listSpaces() did not complete a request round-trip',
  );

  // --- metadata: the catalog push channel + its poll ---------------------------
  const catalog = await load('catalog.js');
  catalog.getCatalog(); // lazily registers the listener and sends the poll
  check('request-api-catalog', sent.includes('request-api-catalog'), 'no catalog poll was sent');
  deliver({ type: 'api-catalog', methods: [{ name: 'spaces:list', capability: 'spaces:user' }] });
  const got = catalog.getCatalog();
  check(
    'api-catalog',
    got.length === 1 && got[0].name === 'spaces:list',
    `the pushed catalog did not reach the SDK (got ${JSON.stringify(got)})`,
  );

  // --- the fs-change push the editor hot-reload loop depends on ----------------
  const onFsChange = await load('onFsChange.js');
  let observedPaths = null;
  onFsChange.onFsChange((change) => {
    observedPaths = change?.paths ?? null;
  });
  deliver({ type: 'fs-change', paths: ['/app/index.tsx'], epoch: 1 });
  check(
    'fs-change',
    Array.isArray(observedPaths) && observedPaths[0] === '/app/index.tsx',
    'the fs-change push never reached the SDK listener',
  );

  return {
    sent: [...new Set(sent)].sort(),
    requested: [...requested].sort(),
    exchanged: [...exchanged].sort(),
    failures,
  };
};

const main = async () => {
  const version = arg('--version') ?? 'latest';
  const { frame, all } = knownNames();
  const { dir, cleanup } = fetchPublished(version);
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const observed = await observe(dir);
    if (observed.failures.length) {
      console.error(`✗ the published SDK ${pkg.version} did not complete an exchange:\n`);
      for (const f of observed.failures) console.error(`  - ${f}`);
      console.error('\nThe frame changed something that app pinned to this SDK depends on.');
      process.exit(1);
    }
    const spoken = [...new Set([...observed.sent, ...observed.requested, ...observed.exchanged])].sort();
    const unknown = spoken.filter((n) => !all.has(n));

    console.log(`SDK @immediately-run/sdk@${pkg.version} (published) against this frame:`);
    console.log(`  sent:      ${observed.sent.join(', ') || '(none)'}`);
    console.log(`  requested: ${observed.requested.join(', ') || '(none)'}`);
    console.log(`  exchanged: ${observed.exchanged.join(', ')} (observed effects, not asserted)`);
    if (unknown.length) {
      console.error(`\n✗ the published SDK speaks ${unknown.length} name(s) this frame's`);
      console.error(`  vocabulary does not contain: ${unknown.join(', ')}`);
      console.error(
        '\nThat is a BREAK for every app pinned to that SDK (SDK_PACKAGING_SPEC §9).\n' +
          'Restore the name additively rather than renaming it.',
      );
      process.exit(1);
    }
    console.log(`\nPASS  all ${spoken.length} exchanged names are in this frame's vocabulary`);
    console.log(`      (${frame.size} frame-handled + the relayed host names).`);
    return { spoken, all };
  } finally {
    cleanup();
  }
};

// ── --self-test: would this notice a rename? ──────────────────────────────────
const selfTest = async () => {
  const { spoken, all } = await main();
  let ok = 0;
  const total = 2;

  // Poison: drop one exchanged name from the vocabulary — a rename looks exactly
  // like this from the published SDK's point of view.
  const victim = spoken.find((n) => n.startsWith('protocol-')) ?? spoken[0];
  const poisoned = new Set([...all].filter((n) => n !== victim));
  const caught = spoken.some((n) => !poisoned.has(n));
  console.log(`${caught ? 'PASS' : 'FAIL'}  detects: \`${victim}\` removed from the vocabulary`);
  if (caught) ok++;

  const cleanOk = spoken.every((n) => all.has(n));
  console.log(`${cleanOk ? 'PASS' : 'FAIL'}  the real vocabulary is clean (no false positive)`);
  if (cleanOk) ok++;

  console.log(`\n${ok}/${total} self-test cases.`);
  if (ok !== total) {
    console.error('\nself-test FAILED — the compat check is not detecting a rename.');
    process.exit(1);
  }
};

if (process.argv.includes('--self-test')) await selfTest();
else await main();
