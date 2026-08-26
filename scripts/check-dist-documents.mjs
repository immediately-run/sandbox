#!/usr/bin/env node
/**
 * check-dist-documents.mjs — the built artifact carries the containment document
 * (roadmap R3-354; `UI_AS_APPS_SPEC` §G1a, `TRUST_MODES_SPEC` §6).
 *
 * ## The failure this exists to make loud
 *
 * `site-main/src/trust/m3Document.ts` is fail-CLOSED at *URL selection*: an M3
 * app always resolves to the hardened document, never back to the baseline one.
 * Nothing verified the document then ARRIVES. Firebase Hosting's SPA rewrite
 * turns a missing file into the baseline document, so a build that emitted no
 * `m3.html` would have served every M3 frame a policy-free document — containment
 * off, with **no error anywhere**: not a 404, not a console warning, not a failed
 * boot. The app would work perfectly, which is the whole problem.
 *
 * The audit found exactly that state one deploy away: production served the right
 * bytes, but a working tree's `dist/` had `index.html` and no `m3.html`.
 *
 * A security control whose absence is indistinguishable from its presence is
 * fail-open by construction. This check is the "distinguishable" part, and it
 * runs at BUILD time so the answer arrives before a deploy rather than after one.
 * (R3-353 tightens the Hosting rewrite so a missing document 404s instead of
 * being fabricated — that is the runtime half of the same fix. Both, because the
 * rewrite is config a deploy could regress and this is not.)
 *
 * ## What it asserts
 *
 * 1. Every document the Hosting config can serve is present in `dist/`.
 * 2. The hardened document carries a policy, and it is the one `m3Csp.ts`
 *    generates — a `m3.html` that shipped with an empty or stale `<meta>` is a
 *    missing document wearing its name.
 * 3. The two documents load the SAME bundler entry chunk — an M3 app must run the
 *    same bundler as every other stance, or "M3" quietly becomes a different
 *    product.
 *
 * `node scripts/check-dist-documents.mjs [distDir]`, and `--self-test` proves it
 * fails on each of those three faults (a check nobody has watched fail is a check
 * nobody knows works).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every document the Hosting configs can serve, and whether it must be hardened. */
const REQUIRED_DOCUMENTS = [
  { file: 'index.html', hardened: false },
  { file: 'm3.html', hardened: true },
];

const readMetaCsp = (html) => {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  return meta ? meta[1] : null;
};

/** The entry `<script type="module" src="…">` a document loads. */
const entryScript = (html) => {
  const m = /<script\s+type="module"\s+src="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
};

/**
 * Read the expected policy out of the SOURCE OF TRUTH rather than restating it.
 * `m3Csp.ts` is TypeScript, so rather than compile it, take the policy from the
 * checked-in `src/m3.html` — which `src/security/m3Csp.test.ts` already gates
 * against `buildM3Csp()` on every test run. That keeps ONE generator and makes
 * this check about DELIVERY (did the built document keep it?), which is the
 * question it is here to answer.
 */
function expectedPolicy() {
  const src = join(ROOT, 'src', 'm3.html');
  if (!existsSync(src)) return null;
  return readMetaCsp(readFileSync(src, 'utf8'));
}

export function checkDistDocuments(distDir, expected) {
  const problems = [];
  const present = new Map();

  for (const { file, hardened } of REQUIRED_DOCUMENTS) {
    const path = join(distDir, file);
    if (!existsSync(path)) {
      problems.push(
        `MISSING ${file} — the build emitted no ${file}. ` +
          (hardened
            ? 'Every M3 frame would be served a document with no containment policy.'
            : 'The baseline bundler document is not in the artifact set.'),
      );
      continue;
    }
    const html = readFileSync(path, 'utf8');
    present.set(file, html);
    if (hardened) {
      const policy = readMetaCsp(html);
      if (!policy) {
        problems.push(`UNPROTECTED ${file} — present but carries no Content-Security-Policy meta.`);
      } else if (expected && policy !== expected) {
        problems.push(
          `STALE ${file} — its policy is not the one src/m3.html carries.\n` +
            `    built:    ${policy}\n` +
            `    expected: ${expected}`,
        );
      }
    }
  }

  const baseline = present.get('index.html');
  const m3 = present.get('m3.html');
  if (baseline && m3) {
    const a = entryScript(baseline);
    const b = entryScript(m3);
    if (!a || !b) {
      problems.push('UNREADABLE entry — one of the documents has no `<script type="module" src>`.');
    } else if (a !== b) {
      problems.push(
        `DIVERGED entry — the two documents load different bundlers (${a} vs ${b}). ` +
          'An M3 app must run the same bundler as every other stance.',
      );
    }
  }
  return problems;
}

// ── self-test ────────────────────────────────────────────────────────────────
// Fault injection, not inspection: build a good fixture, prove it passes, then
// break it three ways and prove each one is caught by name.
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'dist-doc-selftest-'));
  const POLICY = "default-src 'none'; connect-src 'self'";
  const doc = (csp) =>
    `<!DOCTYPE html><html><head>${
      csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}" />` : ''
    }</head><body><script type="module" src="./index.abc123.js"></script></body></html>`;

  const cases = [
    {
      name: 'a healthy artifact set passes',
      write: () => {
        writeFileSync(join(dir, 'index.html'), doc(null));
        writeFileSync(join(dir, 'm3.html'), doc(POLICY));
      },
      expect: null,
    },
    {
      name: 'a MISSING m3.html is caught (the R3-354 finding)',
      write: () => {
        writeFileSync(join(dir, 'index.html'), doc(null));
        rmSync(join(dir, 'm3.html'), { force: true });
      },
      expect: /MISSING m3\.html/,
    },
    {
      name: 'an m3.html with NO policy is caught',
      write: () => {
        writeFileSync(join(dir, 'index.html'), doc(null));
        writeFileSync(join(dir, 'm3.html'), doc(null));
      },
      expect: /UNPROTECTED m3\.html/,
    },
    {
      name: 'an m3.html with a STALE policy is caught',
      write: () => {
        writeFileSync(join(dir, 'index.html'), doc(null));
        writeFileSync(join(dir, 'm3.html'), doc("default-src 'none'"));
      },
      expect: /STALE m3\.html/,
    },
    {
      name: 'two documents on DIFFERENT bundlers are caught',
      write: () => {
        writeFileSync(join(dir, 'index.html'), doc(null));
        writeFileSync(join(dir, 'm3.html'), doc(POLICY).replace('./index.abc123.js', './other.def456.js'));
      },
      expect: /DIVERGED entry/,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    c.write();
    const problems = checkDistDocuments(dir, POLICY);
    const joined = problems.join('\n');
    const ok = c.expect ? c.expect.test(joined) : problems.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!ok) {
      failed++;
      console.log(`      got: ${joined || '(no problems)'}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${cases.length - failed}/${cases.length} self-test cases.`);
  return failed === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  process.exit(selfTest());
}

const dist = args[0] || join(ROOT, 'dist');
if (!existsSync(dist)) {
  console.error(`❌ no ${dist} — run \`npm run build\` first`);
  process.exit(2);
}
const problems = checkDistDocuments(dist, expectedPolicy());
if (problems.length > 0) {
  console.error('❌ dist document check FAILED (R3-354):\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nA missing or unprotected containment document does NOT fail at runtime — the\n' +
      'Hosting rewrite serves the baseline document in its place and every M3 app boots\n' +
      'happily with no CSP. That is why this is a red build.',
  );
  process.exit(1);
}
console.log(
  `✅ dist documents OK — ${REQUIRED_DOCUMENTS.map((d) => d.file).join(', ')} present, ` +
    'm3.html carries the generated policy, both load the same bundler entry.',
);
