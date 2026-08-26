#!/usr/bin/env node
// check-dependency-pins.mjs — CHECK 1 of roadmap R3-327: a PR must not pin an
// `@immediately-run/*` version that is not published, and `package.json` and
// `package-lock.json` must agree on what it is.
//
// THE FAILURE THIS EXISTS FOR. `sdk #112` bumped `@immediately-run/sandbox-protocol`
// to `0.4.0` in `package.json` while that version was unpublished — it publishes from
// THAT repo's release CI on merge to ITS `main`, and that PR had not landed. The
// publish→pin order was stated in the PR body and in the roadmap item; nothing enforced
// it. The PR's check went red in 15 seconds with the exact error and it merged anyway,
// after which `main` failed for every subsequent run: first
//
//     ETARGET No matching version found for @immediately-run/sandbox-protocol@0.4.0
//
// and then, once the version WAS published,
//
//     EUSAGE Invalid: lock file's @immediately-run/sandbox-protocol@0.3.1 does not
//            satisfy @immediately-run/sandbox-protocol@0.4.0
//
// because the lockfile could not be refreshed against a package that did not exist yet.
// Both halves are checked here: skipping the second just moves the failure from ETARGET
// to EUSAGE.
//
// SAY WHAT TO DO, NOT WHAT WENT WRONG. `ETARGET` inside 40 lines of npm output is why
// the red check on #112 read as noise. The message below names the upstream repo, the
// mechanism that publishes it, and the command to run afterwards.
//
// ITERATING LOCALLY MUST STAY POSSIBLE. A dev linking a sibling checkout
// (`npm link @immediately-run/sandbox-protocol`) has an unpublished version resolved on
// purpose, and the protocol snapshot gates explicitly support that. So the REGISTRY half
// runs only in CI (or with `--registry`); a local run does the offline manifest↔lock
// half and says so. A linked package is skipped by name, wherever it runs.
//
// AN UNREACHABLE REGISTRY IS A THIRD OUTCOME, NOT A PASS. "not published" and "could not
// tell" are different answers, and a check that silently treats the second as the first
// is worse than no check. A registry error fails in CI, with the error attached.
//
// Copied, not shared. The rule is ~40 lines; a shared package for it would itself be a
// cross-repo dependency to coordinate — the tax `cross_repo_migration.mdx` weighs, and
// the reason `dualRead.mjs` is copied rather than imported.
//
// Run: `node scripts/check-dependency-pins.mjs`
//      `node scripts/check-dependency-pins.mjs --registry`    (force the network half)
//      `node scripts/check-dependency-pins.mjs --self-test`   (prove it can fail)

import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCOPE = '@immediately-run/';

/** Where each scoped package publishes from, so the message can name it. */
const REPO_OF = {
  '@immediately-run/sandbox-protocol': 'immediately-run/immediately-run-sandbox-protocol',
  '@immediately-run/platform-constants': 'immediately-run/immediately-run-platform-constants',
  '@immediately-run/preauth-core': 'immediately-run/immediately-run-preauth-core',
  '@immediately-run/sdk': 'immediately-run/immediately-run-sdk',
  '@immediately-run/cli': 'immediately-run/immediately-run-cli',
  '@immediately-run/mdx-plugins': 'immediately-run/immediately-run-mdx-plugins',
  '@immediately-run/transpiler': 'immediately-run/transpiler',
  '@immediately-run/safe-content': 'immediately-run/immediately-run-sdk',
  '@immediately-run/worker-transport': 'immediately-run/immediately-run-worker-transport',
  '@immediately-run/prettier-config': 'immediately-run/prettier-config',
  '@immediately-run/sandpack-client': 'immediately-run/immediately-run-sandpack',
  '@immediately-run/sandpack-react': 'immediately-run/immediately-run-sandpack',
};

/** An exact version — anything else (`^1.2.3`, `file:`, `link:`, `*`) is a range. */
const isExact = (spec) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec);

/** Every `@immediately-run/*` entry across the three dependency maps. */
export function collectPins(pkg) {
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith(SCOPE) && typeof spec === 'string') out.push({ name, spec, field });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The version `package-lock.json` actually resolved for `name`, or `null`. */
export function lockVersion(lock, name) {
  const entry = lock?.packages?.[`node_modules/${name}`];
  if (entry && typeof entry.version === 'string') return entry.version;
  const legacy = lock?.dependencies?.[name];
  return legacy && typeof legacy.version === 'string' ? legacy.version : null;
}

const suggest = (versions) => (versions.length ? versions.slice(-4).reverse().join(', ') : '(none published)');

/**
 * The pure checker. `published` maps a package name to a registry result:
 *   `{ ok: true, versions: string[] }`            — the registry answered
 *   `{ ok: false, kind: 'not-found' }`            — the PACKAGE does not exist
 *   `{ ok: false, kind: 'undetermined', detail }` — we could not tell
 * A missing entry means the registry half was not run (local, offline mode).
 */
export function checkPins({ pkg, lock, published = {}, linked = [], registryChecked }) {
  const errors = [];
  const notes = [];
  const pins = collectPins(pkg);
  if (pins.length === 0) return { errors, notes, pins, checked: 0 };

  let checked = 0;
  for (const { name, spec, field } of pins) {
    if (linked.includes(name)) {
      // A linked sibling checkout resolves an unpublished version ON PURPOSE.
      notes.push(`${name} is npm-linked locally — skipped (link a sibling checkout, iterate freely).`);
      continue;
    }
    if (spec.startsWith('file:') || spec.startsWith('link:') || spec.startsWith('workspace:')) {
      notes.push(`${name} is a ${spec.split(':')[0]}: dependency — not a published pin, skipped.`);
      continue;
    }
    checked++;
    const locked = lockVersion(lock, name);
    const repo = REPO_OF[name];
    const where = repo ? `https://github.com/${repo}` : 'its own repository';

    // ── half 1: package.json and package-lock.json agree ────────────────────
    // Offline, always decidable, and the half that turns `ETARGET` into `EUSAGE`
    // if you skip it.
    if (locked === null) {
      errors.push(
        `${name} is declared in ${field} as \`${spec}\` but has NO entry in package-lock.json.\n` +
          `   Run \`npm install\` and commit the lockfile — \`npm ci\` on main will fail without it.`,
      );
      continue;
    }
    if (isExact(spec) && locked !== spec) {
      errors.push(
        `${name}: package.json pins \`${spec}\` but package-lock.json resolved \`${locked}\`.\n` +
          `   \`npm ci\` refuses this ("lock file's ${name}@${locked} does not satisfy ${name}@${spec}").\n` +
          `   Run \`npm install\` here to refresh the lockfile, and commit it.`,
      );
      continue;
    }

    // ── half 2: the version actually exists on the registry ─────────────────
    const reg = published[name];
    if (!reg) continue; // registry half not run (local mode) — reported below
    if (!reg.ok) {
      if (reg.kind === 'not-found') {
        errors.push(`${name} is not published at all. Check the package name (${where}).`);
      } else {
        // UNDETERMINED IS NOT ABSENT. Say which it is, and fail — a check that
        // silently downgrades "could not tell" to "fine" stops being a check.
        errors.push(
          `${name}: could NOT determine published versions (${reg.detail ?? 'registry error'}).\n` +
            `   This is not a pass. Re-run when the registry is reachable.`,
        );
      }
      continue;
    }
    const want = isExact(spec) ? spec : locked;
    if (reg.versions.includes(want)) continue;
    errors.push(
      `package.json pins ${name}@${want}, which is NOT published.\n` +
        `   It publishes from that repo's release CI on merge to its \`main\` — land that PR first\n` +
        `   (${where}), then run \`npm install\` here to refresh the lockfile.\n` +
        `   Published versions: ${suggest(reg.versions)}`,
    );
  }
  if (registryChecked === false) {
    notes.push(
      'Registry half SKIPPED (not CI, no --registry): checked manifest↔lockfile agreement only. ' +
        'CI runs the full check.',
    );
  }
  return { errors, notes, pins, checked };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/** Ask npm for a package's published versions. Distinguishes the three outcomes. */
function fetchVersions(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    const parsed = JSON.parse(out);
    return { ok: true, versions: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
    if (/E404|is not in this registry|404 Not Found/i.test(text)) return { ok: false, kind: 'not-found' };
    return { ok: false, kind: 'undetermined', detail: text.trim().split('\n')[0]?.slice(0, 160) };
  }
}

/** Which scoped packages are `npm link`ed here (a symlink under node_modules). */
function linkedPackages(pins) {
  return pins
    .map((p) => p.name)
    .filter((name) => {
      const p = join('node_modules', name);
      try {
        return existsSync(p) && lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });
}

// ── self-test: prove the gate can actually fail ──────────────────────────────
if (process.argv.includes('--self-test')) {
  let failures = 0;
  const expect = (label, got, matcher) => {
    const joined = got.errors.join('\n');
    if (!matcher.test(joined)) {
      console.error(`SELF-TEST FAIL: ${label}\n  got: ${joined || '(no errors)'}`);
      failures++;
    } else {
      console.log(`  ok  ${label}`);
    }
  };
  const lockOf = (name, version) => ({ packages: { [`node_modules/${name}`]: { version } } });
  const PROTO = '@immediately-run/sandbox-protocol';

  // 1. THE sdk #112 REPLAY. Its exact diff: package.json bumped to 0.4.0 while the
  //    registry held only up to 0.3.1, and the lockfile still on 0.3.1.
  const r112 = checkPins({
    pkg: { dependencies: { [PROTO]: '0.4.0' } },
    lock: lockOf(PROTO, '0.3.1'),
    published: { [PROTO]: { ok: true, versions: ['0.1.0', '0.2.0', '0.3.0', '0.3.1'] } },
  });
  expect("sdk #112's diff fails on the lockfile disagreement", r112, /does not satisfy/);

  // …and with the lockfile refreshed but the version still unpublished, it fails on
  // the registry, naming the upstream repo to land first and what IS published.
  const r112b = checkPins({
    pkg: { dependencies: { [PROTO]: '0.4.0' } },
    lock: lockOf(PROTO, '0.4.0'),
    published: { [PROTO]: { ok: true, versions: ['0.1.0', '0.2.0', '0.3.0', '0.3.1'] } },
  });
  expect('an unpublished pin fails and names the upstream repo', r112b, /is NOT published/);
  expect('…and names where it publishes from', r112b, /immediately-run-sandbox-protocol/);
  expect('…and lists what IS published', r112b, /Published versions: 0\.3\.1, 0\.3\.0/);

  // 2. a missing lockfile entry fails (the other way to reach `npm ci` failure)
  expect(
    'a pin with no lockfile entry fails',
    checkPins({ pkg: { dependencies: { [PROTO]: '0.5.0' } }, lock: {} }),
    /NO entry in package-lock/,
  );

  // 3. an UNDETERMINED registry answer fails — it is not "fine"
  expect(
    'an unreachable registry fails rather than passing',
    checkPins({
      pkg: { dependencies: { [PROTO]: '0.5.0' } },
      lock: lockOf(PROTO, '0.5.0'),
      published: { [PROTO]: { ok: false, kind: 'undetermined', detail: 'ETIMEDOUT' } },
    }),
    /could NOT determine/,
  );

  // 4. a package that does not exist at all is its own message
  expect(
    'a nonexistent package fails distinctly',
    checkPins({
      pkg: { dependencies: { '@immediately-run/typo': '1.0.0' } },
      lock: lockOf('@immediately-run/typo', '1.0.0'),
      published: { '@immediately-run/typo': { ok: false, kind: 'not-found' } },
    }),
    /not published at all/,
  );

  // ── and the cases that must PASS ────────────────────────────────────────────
  const passes = (label, got) => {
    if (got.errors.length) {
      console.error(`SELF-TEST FAIL: ${label}\n  got: ${got.errors.join('\n')}`);
      failures++;
    } else {
      console.log(`  ok  ${label}`);
    }
  };
  passes(
    'a published, lock-agreeing exact pin passes',
    checkPins({
      pkg: { dependencies: { [PROTO]: '0.5.0' } },
      lock: lockOf(PROTO, '0.5.0'),
      published: { [PROTO]: { ok: true, versions: ['0.4.0', '0.5.0'] } },
    }),
  );
  passes(
    'a RANGE is judged on what the lockfile resolved, not on the range text',
    checkPins({
      pkg: { dependencies: { '@immediately-run/sandpack-client': '^2.21.0' } },
      lock: lockOf('@immediately-run/sandpack-client', '2.21.3'),
      published: { '@immediately-run/sandpack-client': { ok: true, versions: ['2.21.0', '2.21.3'] } },
    }),
  );
  passes(
    'an npm-linked package is skipped — iterating locally must stay possible',
    checkPins({
      pkg: { dependencies: { [PROTO]: '0.9.9' } },
      lock: lockOf(PROTO, '0.9.9'),
      published: { [PROTO]: { ok: true, versions: ['0.5.0'] } },
      linked: [PROTO],
    }),
  );
  passes(
    'a repo with no @immediately-run/* pins is not an error',
    checkPins({ pkg: { dependencies: { react: '^19.0.0' } }, lock: {} }),
  );

  if (failures) {
    console.error(`\n${failures} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log('11/11 self-test cases.');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = existsSync('package-lock.json') ? JSON.parse(readFileSync('package-lock.json', 'utf8')) : {};
const pins = collectPins(pkg);
const linked = linkedPackages(pins);
// CI always hits the registry; locally it is opt-in, so a dev mid-change is never
// blocked by a version that has not been published yet on purpose.
const useRegistry = process.argv.includes('--registry') || !!process.env.CI;
const published = {};
if (useRegistry) {
  for (const { name } of pins) if (!linked.includes(name)) published[name] = fetchVersions(name);
}

const { errors, notes, checked } = checkPins({ pkg, lock, published, linked, registryChecked: useRegistry });
for (const n of notes) console.log(`note: ${n}`);
if (errors.length) {
  console.error('\ndependency-pin check FAILED:\n');
  for (const e of errors) console.error(` - ${e}\n`);
  console.error(
    `${errors.length} problem(s). A pin to an unpublished version turns every subsequent \`npm ci\` on\n` +
      `main red, which is what it did on 2026-08-24 (R3-327).`,
  );
  process.exit(1);
}
console.log(
  checked === 0
    ? 'OK: no @immediately-run/* pins to check in this repo.'
    : `OK: ${checked} @immediately-run/* pin(s) ${
        useRegistry ? 'published and ' : ''
      }in agreement with package-lock.json.`,
);
