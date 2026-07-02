#!/usr/bin/env node
// check-importmap-parity.mjs — fail the build loud if the emitted `dist/` and the
// module references in `dist/index.html` disagree (R3-155).
//
// Two failure modes this guards, both born of a non-clean build shipping stale bytes:
//   1. DANGLING — index.html (script src / importmap value / modulepreload) references a
//      hashed chunk that is NOT present in dist/. In prod this 404s; before R3-155's
//      firebase.json rewrite scoping it fell through the SPA rewrite to index.html and
//      surfaced as the cryptic "Expected a JavaScript-or-Wasm module script but the server
//      responded with a MIME type of text/html" — breaking edit-mode live-transpile.
//   2. ORPHAN — a hashed *.js chunk sits in dist/ that nothing in index.html references
//      (a leftover from a prior build). Harmless to serve but a signal the build wasn't
//      cleaned; the exit criteria require a clean build to emit none.
//
// Runs after `build:parcel` in `build`. `.js.map` sourcemaps are referenced only via the
// per-file `//# sourceMappingURL` comment, so they are excluded from orphan detection.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const INDEX = join(DIST, 'index.html');

function fail(msg) {
  console.error(`\n❌ importmap parity check failed:\n${msg}\n`);
  process.exit(1);
}

if (!existsSync(INDEX)) fail(`no dist/index.html — did the build run? (${INDEX})`);

const html = readFileSync(INDEX, 'utf8');

// Every module URL the browser will fetch: importmap values + <script src> + modulepreload.
const referenced = new Set();

// 1. importmap values
const importmapMatch = html.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
if (importmapMatch) {
  let map;
  try {
    map = JSON.parse(importmapMatch[1]);
  } catch (e) {
    fail(`dist/index.html has an unparseable importmap: ${e.message}`);
  }
  for (const url of Object.values(map.imports ?? {})) referenced.add(url);
  for (const scope of Object.values(map.scopes ?? {})) {
    for (const url of Object.values(scope)) referenced.add(url);
  }
}

// 2. <script src="..."> and 3. <link rel="modulepreload" href="...">
for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)) referenced.add(m[1]);
for (const m of html.matchAll(/<link[^>]*\srel=["']modulepreload["'][^>]*\shref=["']([^"']+)["']/gi))
  referenced.add(m[1]);

// Keep only local (same-origin, absolute-path) .js references; CDN/bare specifiers are not
// files we emit and are out of scope for a dist parity check.
const referencedJs = [...referenced].filter((u) => u.startsWith('/') && u.endsWith('.js'));

// DANGLING: referenced but missing from dist/
const dangling = referencedJs.filter((u) => !existsSync(join(DIST, u.replace(/^\//, ''))));

// ORPHAN: hashed *.js in dist/ that index.html never references (exclude *.js.map sourcemaps).
const referencedNames = new Set(referencedJs.map((u) => u.replace(/^\//, '')));
const distJs = readdirSync(DIST).filter((f) => f.endsWith('.js') && !f.endsWith('.js.map'));
const orphans = distJs.filter((f) => !referencedNames.has(f));

const problems = [];
if (dangling.length)
  problems.push(
    `  DANGLING (referenced in index.html, missing from dist/):\n` +
      dangling.map((u) => `    - ${u}`).join('\n'),
  );
if (orphans.length)
  problems.push(
    `  ORPHAN (present in dist/, unreferenced — stale build, run a clean build):\n` +
      orphans.map((f) => `    - /${f}`).join('\n'),
  );

if (problems.length) fail(problems.join('\n'));

console.log(
  `✅ importmap parity OK — ${referencedJs.length} referenced chunk(s), ${distJs.length} emitted, no dangling/orphan refs.`,
);
