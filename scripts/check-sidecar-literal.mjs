#!/usr/bin/env node
// check-sidecar-literal.mjs — drift gate for R3-104 (ways_of_working §7).
//
// The `.immediately.run/` cache-zip sidecar layout is owned by
// @immediately-run/platform-constants and imported, NOT hard-coded. This fails the
// build if a raw sidecar-PATH literal reappears in src (someone re-introducing the
// duplication the package exists to kill). The bare hostname suffix `.immediately.run`
// (no trailing slash, used in origin allowlists) is intentionally NOT matched — only
// the directory/path form `.immediately.run/` is.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src';
const SIDECAR_PATH = /['"`][./]*\.immediately\.run\//;

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '') // block / JSDoc comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (the [^:] spares http://)
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e !== 'node_modules') walk(p, out);
      // `*.generated.ts` is build-time output, not authored source. The authoring
      // worker's bundled type set embeds other packages' .d.ts verbatim — including
      // @immediately-run/platform-constants, whose whole job is to DECLARE these
      // literals. Scanning it would fail the build for the constants package doing
      // exactly what R3-104 asks of it (R3-329).
    } else if (
      /\.(ts|tsx|mts|cts|js|mjs)$/.test(e) &&
      !/\.test\./.test(e) &&
      !/\.generated\.(ts|js)$/.test(e) &&
      !p.includes('/test/')
    ) {
      out.push(p);
    }
  }
  return out;
}

let hits = 0;
for (const f of walk(ROOT)) {
  stripComments(readFileSync(f, 'utf8'))
    .split('\n')
    .forEach((line, i) => {
      if (SIDECAR_PATH.test(line)) {
        console.error(
          `${f}:${i + 1}: raw .immediately.run/ literal — import from ` +
            `@immediately-run/platform-constants instead (R3-104): ${line.trim()}`,
        );
        hits++;
      }
    });
}
if (hits) {
  console.error(`\n${hits} raw sidecar-path literal(s). Own the layout in @immediately-run/platform-constants.`);
  process.exit(1);
}
console.log('OK: no raw .immediately.run/ sidecar-path literal in src.');
