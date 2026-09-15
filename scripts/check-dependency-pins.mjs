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
// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2: a LOCKSTEP pin — one that must be the SAME version in more than one repo —
// is on the target every one of those repos converges on.
//
// THE FAILURE THIS EXISTS FOR. `@immediately-run/transpiler` is pinned in TWO repos and
// must be the same version in both: site-main vendors the package's prebuilt `worker/`
// bytes into `public/babel-worker/` (the same-origin Babel worker), and sandbox links it
// for the iframe's live-transpile. R3-149 co-located the worker with its logic so these
// are one version BY CONSTRUCTION, and the deploy asserts it (SIMPLIFIED_DEPLOYMENT_SPEC
// §14.3 pt-4).
//
// On 2026-09-14 R3-600 published transpiler 0.9.0 and bumped `sandbox` and `cli`. Its
// roadmap `repos:` list did not name site-main, so the worker stayed on 0.8.1. Nothing
// said so until the next production deploy:
//
//     Babel-worker transpiler (0.8.1) != sandbox iframe transpiler (0.9.0).
//
// The deploy gate worked — it just spoke a day late, after four dispatched runs that
// deployed NOTHING (each recorded `deployed: false` for every component). This check
// moves the same assertion to PR time, in both pinning repos.
//
// EACH REPO CONVERGES ON npm's `latest` — IT NEVER READS ITS PARTNER. The obvious design
// is "fetch the partner's package.json and compare". It does not work here, and the
// reason is worth writing down so nobody rebuilds it:
//
//   - `site-main` is a PRIVATE repo. raw.githubusercontent.com answers 404 for it
//     unauthenticated, and a run's `secrets.GITHUB_TOKEN` is scoped to its OWN repo, so
//     sandbox's CI cannot read site-main's pin at all. Only an org-wide App token could,
//     which means a cross-repo secret in a PUBLIC repo's PR CI — more attack surface than
//     the bug is worth.
//   - It also DEADLOCKS. A package version cannot be dual-read: `cross_repo_migration.mdx`
//     calls a must-land-together set the failure mode and reserves a true lockstep "only
//     for when dual-read is genuinely impossible" — this is that case, so the two PRs
//     cannot merge atomically. Compare-to-partner blocks whoever bumps FIRST, on a partner
//     that cannot move until they land.
//
// So the rule is not "agree with your partner" but "agree with the PUBLISHED TRUTH both of
// you already depend on": a lockstep pin must equal the package's `latest` dist-tag. Both
// repos converge on one external value, independently, in any order, with no cross-repo
// read, no auth, no private-repo problem, and no deadlock. Agreement is then transitive —
// if both equal `latest`, both equal each other.
//
// A DELIBERATE HOLD IS EXPRESSIBLE. Set `hold` on the LOCKSTEP entry to an exact version —
// in BOTH repos, which is a reviewed act in each — to stay on an older transpiler on
// purpose. `hold` is then the target instead of `latest`.
//
// THE COST, STATED: publishing a new transpiler turns both repos' PRs red until each bumps.
// That is the intended pressure (an unadopted publish IS the R3-600 bug), and the failure
// names the one command that fixes it. `hold` is the escape when adoption must wait.
//
// IT COSTS NO EXTRA CI, AND NO EXTRA NETWORK. `latest` arrives in the SAME `npm view` call
// the registry half above already makes — `versions` and `dist-tags` in one request. No
// cross-repo dispatch, no scheduled poll, no new job, and nothing that fires on a `docs`
// commit (`docs` deliberately runs CI on PR / 4-hourly poll / dispatch only — never on
// push to `main`, which is where the roadmap ledger lands ~75 commits/day).
//
// Run: `node scripts/check-dependency-pins.mjs`
//      `node scripts/check-dependency-pins.mjs --registry`    (force the network halves)
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

/**
 * Packages that must carry the SAME version in more than one repo, and why. Keep the
 * `why` short enough to print: it is what a reader who has never heard of R3-149 sees.
 */
const LOCKSTEP = {
  '@immediately-run/transpiler': {
    repos: ['immediately-run/immediately-run-site-main', 'immediately-run/sandbox'],
    // An exact version to stay on deliberately, instead of tracking `latest`. Setting it
    // in ONE repo only re-creates the skew this check exists to catch — change it in BOTH,
    // in the same pair of PRs, or not at all.
    hold: null,
    why:
      "site-main vendors this package's prebuilt worker/ bytes as the same-origin Babel worker; " +
      'sandbox links it for the iframe live-transpile. They must be one version (R3-149; ' +
      'SIMPLIFIED_DEPLOYMENT_SPEC §14.3 pt-4), and the deploy fails on skew.',
  },
};

/**
 * Which repo this checkout IS, keyed by its `package.json` name — so the one copied file
 * stays byte-identical in every repo that carries it. A name that is absent here simply
 * has no lockstep partners, which is the correct answer for a third repo copying this
 * script.
 */
const SELF_REPO_BY_PKG_NAME = {
  '@immediately-run/main': 'immediately-run/immediately-run-site-main',
  '@immediately-run/sandbox': 'immediately-run/sandbox',
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

/**
 * CHECK 2 (pure). Assert every LOCKSTEP pin this repo carries equals the target both
 * partner repos converge on: the entry's `hold`, or the package's `latest` dist-tag.
 * Reuses the registry half's `published` map, so it costs no extra call:
 *   `{ ok: true, versions: string[], latest: string | null }`
 * A missing entry means the registry half was not run (local, offline mode).
 */
export function checkLockstep({ selfRepo, pkg, lock, published = {} }) {
  const errors = [];
  const notes = [];
  let checked = 0;
  if (!selfRepo) {
    notes.push(`this checkout's package name (${pkg?.name ?? 'unknown'}) declares no lockstep pins — skipped.`);
    return { errors, notes, checked };
  }

  for (const [name, { repos, hold, why }] of Object.entries(LOCKSTEP)) {
    if (!repos.includes(selfRepo)) continue;
    const pin = collectPins(pkg).find((p) => p.name === name);
    if (!pin) continue; // this repo is listed but no longer pins it — CHECK 1's business
    const partners = repos.filter((r) => r !== selfRepo).join(', ');

    // A LOCKSTEP PIN MUST BE EXACT. A range is not a version: `^0.8.1` in two repos can
    // resolve to different bytes on two different `npm install` days, which is the very
    // skew this exists to prevent. Exactness also makes CHECK 1's manifest↔lock agreement
    // mean the declared spec IS what installs.
    if (!isExact(pin.spec)) {
      errors.push(
        `${name} is a lockstep pin with ${partners}, so it must be an EXACT version —\n` +
          `   \`${pin.spec}\` is a range, which can resolve differently in each repo.\n` +
          `   Pin the exact version in ${pin.field} and run \`npm install\`.`,
      );
      continue;
    }
    const locked = lockVersion(lock, name);
    if (locked !== null && locked !== pin.spec) continue; // CHECK 1 already failed on this

    const reg = published[name];
    if (!reg) continue; // registry half not run — reported by the caller
    if (!reg.ok) continue; // CHECK 1 already errored on the registry outcome

    // The target both repos converge on, with no cross-repo read. See the header.
    const target = hold ?? reg.latest;
    if (target === null || target === undefined) {
      // UNDETERMINED IS NOT AGREEMENT — the same rule the registry half runs on.
      errors.push(
        `${name}: the registry answered, but carries NO \`latest\` dist-tag, so the lockstep\n` +
          `   target is unknown. This is not a pass — set \`hold\` on the LOCKSTEP entry (in every\n` +
          `   repo in ${repos.join(', ')}) or fix the package's dist-tags.`,
      );
      continue;
    }
    checked++;
    if (pin.spec === target) continue;

    const source = hold ? 'the declared `hold` on the LOCKSTEP entry' : `${name}'s \`latest\` dist-tag`;
    errors.push(
      `${name}: this repo pins \`${pin.spec}\`, but the lockstep target is \`${target}\` (${source}).\n` +
        `   Every repo that carries it (${repos.join(', ')}) converges on that same target, so a\n` +
        `   pin that differs here is a SKEW against ${partners} —\n` +
        `   the production deploy fails on it before it ships anything.\n` +
        `   Fix: \`npm install ${name}@${target}\` and commit package.json + package-lock.json.\n` +
        (hold
          ? `   To move OFF the hold, change \`hold\` in EVERY repo that carries it (${repos.join(', ')}).\n`
          : `   Staying behind on purpose? Set \`hold: '${pin.spec}'\` on the LOCKSTEP entry in EVERY\n` +
            `   repo that carries it (${repos.join(', ')}) — one repo alone re-creates the skew.\n`) +
        `   Why they must match: ${why}`,
    );
  }
  return { errors, notes, checked };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/**
 * Ask npm for a package's published versions AND its `latest` dist-tag. Distinguishes the
 * three outcomes. Both fields come from ONE request, so CHECK 2 adds no network cost:
 * `npm view <pkg> versions dist-tags --json` → `{ versions: [...], "dist-tags": {...} }`.
 */
function fetchVersions(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', 'dist-tags', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    const parsed = JSON.parse(out);
    // With two fields npm returns an object; with one matching version it can still
    // collapse `versions` to a bare string, so normalise both shapes.
    const raw = parsed?.versions ?? parsed;
    return {
      ok: true,
      versions: Array.isArray(raw) ? raw : [raw],
      latest: parsed?.['dist-tags']?.latest ?? null,
    };
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
  let ran = 0;
  const expect = (label, got, matcher) => {
    const joined = got.errors.join('\n');
    if (!matcher.test(joined)) {
      console.error(`SELF-TEST FAIL: ${label}\n  got: ${joined || '(no errors)'}`);
      failures++;
    } else {
      console.log(`  ok  ${label}`);
    }
    ran++;
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
    ran++;
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

  // ── CHECK 2: the lockstep pin ───────────────────────────────────────────────
  const TP = '@immediately-run/transpiler';
  const SITE = 'immediately-run/immediately-run-site-main';
  const SBX = 'immediately-run/sandbox';
  /** This repo pinning `mine`, with npm's `latest` on `latest`. */
  const lockstepOf = (selfRepo, mine, latest) =>
    checkLockstep({
      selfRepo,
      pkg: { name: 'x', dependencies: { [TP]: mine } },
      lock: lockOf(TP, mine),
      published: { [TP]: { ok: true, versions: ['0.8.1', '0.9.0'], latest } },
    });

  // 5. THE R3-600 REPLAY — the failure that cost four dead deploy runs. transpiler 0.9.0
  //    was published and adopted in sandbox; site-main sat on 0.8.1 and nothing said so.
  const laggard = lockstepOf(SITE, '0.8.1', '0.9.0');
  expect('R3-600 replay: a pin behind the lockstep target fails', laggard, /lockstep target is `0\.9\.0`/);
  expect('…and names the one command that fixes it', laggard, /npm install @immediately-run\/transpiler@0\.9\.0/);
  expect('…and says why the repos must match', laggard, /same-origin Babel worker/);
  expect('…and names the deliberate-hold escape', laggard, /hold: '0\.8\.1'/);

  //    THE SAME RULE FIRES IN BOTH REPOS — the point of converging on an external value.
  //    Had sandbox been the laggard, its own CI would have said the identical thing.
  expect('the identical rule fires from the sandbox side', lockstepOf(SBX, '0.8.1', '0.9.0'), /SKEW/);

  // 6. the adopted state is silent, in both repos
  passes('a pin on the lockstep target passes (site-main)', lockstepOf(SITE, '0.9.0', '0.9.0'));
  passes('a pin on the lockstep target passes (sandbox)', lockstepOf(SBX, '0.9.0', '0.9.0'));

  // 7. a RANGE cannot be a lockstep pin — `^0.9.0` in two repos is two resolutions
  expect('a range lockstep pin fails', lockstepOf(SITE, '^0.9.0', '0.9.0'), /must be an EXACT version/);

  // 8. NO `latest` DIST-TAG IS UNDETERMINED, NOT AGREEMENT — same rule as the registry half
  expect(
    'a package with no latest dist-tag fails rather than passing',
    lockstepOf(SITE, '0.9.0', null),
    /NO `latest` dist-tag/,
  );

  // 9. a declared `hold` overrides `latest` — and is judged against the hold, both ways
  const held = { ...LOCKSTEP[TP], hold: '0.8.1' };
  const withHold = (mine) => {
    const saved = LOCKSTEP[TP];
    LOCKSTEP[TP] = held;
    try {
      return lockstepOf(SITE, mine, '0.9.0');
    } finally {
      LOCKSTEP[TP] = saved;
    }
  };
  passes('a declared hold pins the target below latest', withHold('0.8.1'));
  expect('…and a pin that ignores the hold still fails', withHold('0.9.0'), /the declared `hold`/);

  // 10. a repo that carries this script but declares no lockstep pins is not an error
  passes(
    'a repo with no lockstep pins is skipped, not failed',
    checkLockstep({ selfRepo: null, pkg: { name: '@immediately-run/other' }, lock: {} }),
  );

  // 11. the registry half not having run is a SKIP, never a silent pass
  passes(
    'the lockstep half is inert when the registry half did not run',
    checkLockstep({ selfRepo: SITE, pkg: { name: 'x', dependencies: { [TP]: '0.1.0' } }, lock: lockOf(TP, '0.1.0') }),
  );

  if (failures) {
    console.error(`\n${failures} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log(`${ran}/${ran} self-test cases.`);
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

// CHECK 2 reads the SAME `published` map the registry half just built — it needs the
// `latest` dist-tag and nothing else, so it costs no extra call and rides the same gate:
// on in CI, opt-in locally, so a dev mid-bump is never blocked by a version that is not
// published yet on purpose. A linked package is skipped there, so it is skipped here too.
const selfRepo = SELF_REPO_BY_PKG_NAME[pkg.name] ?? null;
const lockstep = checkLockstep({ selfRepo, pkg, lock, published });
if (!useRegistry) {
  notes.push("Lockstep half SKIPPED (not CI, no --registry): npm's latest dist-tag not read. CI runs it.");
}

for (const n of [...notes, ...lockstep.notes]) console.log(`note: ${n}`);

const allErrors = [...errors, ...lockstep.errors];
if (allErrors.length) {
  console.error('\ndependency-pin check FAILED:\n');
  for (const e of allErrors) console.error(` - ${e}\n`);
  console.error(
    `${allErrors.length} problem(s). A pin to an unpublished version turns every subsequent \`npm ci\` on\n` +
      `main red, which is what it did on 2026-08-24 (R3-327); a lockstep pin out of step with its partner\n` +
      `fails the production deploy before it ships anything, which is what it did on 2026-09-14 (R3-600).`,
  );
  process.exit(1);
}
console.log(
  checked === 0
    ? 'OK: no @immediately-run/* pins to check in this repo.'
    : `OK: ${checked} @immediately-run/* pin(s) ${
        useRegistry ? 'published and ' : ''
      }in agreement with package-lock.json.` +
        (lockstep.checked ? ` ${lockstep.checked} lockstep pin(s) on the shared target.` : ''),
);
