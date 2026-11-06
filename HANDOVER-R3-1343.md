# Handover — R3-1343: library artifacts without hot-reload code (rework of this PR)

> Written 2026-11-06 by the session that traced the bug (claude-code-local:06e494b3), for
> the session that will rework this PR. **Delete this file in the rework's first commit**;
> it must not merge.

## TL;DR

This PR (#143, commit `23d9790`) fixes the false "artifact-integrity:distrust" alarm by
making `spotVerify` re-transpile a git-library module **at `/app/<path>`** — i.e. it
*accepts* the library's react-refresh–wrapped artifacts. **The owner rejected that
direction on 2026-11-05/06.** The owner's rulings:

1. **Library code must not carry the hot-reload (react-refresh) envelope.** A module
   served from a library mount must be byte-identical to what the in-browser transpile of
   that module *at its mounted path* yields — which has no refresh code.
2. **Git libraries should still be able to run from pre-transpiled cached zips.** Packaging
   two transpiled variants in one zip is acceptable (the transpiled output is small).
3. **The library variant is opt-in per repository**, enabled by a key in the repo's
   immediately.run config (`immediately.run.json` / `package.json#immediately.run`) —
   not built for every zip.

So the PR's code change (`publisherPathFor`) is to be **reverted**, and the work split as
below. Step A is this PR; steps B–D are a new roadmap item.

## The bug, as traced (all verified on 2026-11-05)

- Symptom (prod, `https://immediately.run/present/github/immediately-run/baton/main/bundle/tickets/`):
  console `Artifact spot-verify transpile-mismatch at /node_modules/@immediately-run/grove/src/components/GroveNav.tsx — all artifacts discarded for this session (UI_AS_APPS §8.14)`,
  plus a host notification "A security check protected you — artifact-integrity:distrust"
  (the orange dot on the platform-menu tab), plus a persisted distrust mark for the app's
  `(coords, commitSha)` (baton `284da70`) so that commit never uses its cache again in
  that browser until baton's `main` moves.
- Cause: one zip per repo, built by the CLI at `/app/<path>`
  (`immediately-run-cli:src/artifacts.ts` `emitArtifacts`, `runtimePath = ${APP_ROOT}/${rel}`).
  The transpiler's react preset picks the chain by path
  (`transpiler:src/presets/react.ts`, `APP_ROOT_REFRESH_RE = /^(?!\/node_modules\/).*\.((m|c)?jsx?|tsx)$/i`,
  `MDX_APP_ROOT_RE`): app-root `.tsx/.jsx/.js(.m/.c)` get `REACT_REFRESH_BABEL_CONFIG`,
  `/node_modules/**` gets `PLAIN_BABEL_CONFIG`. When grove is mounted as a git library at
  `/node_modules/@immediately-run/grove`, `seedRoot` (`artifactStore.ts`, the per-root seed)
  seeds its `/app`-built (refresh) artifacts, and `spotVerify`
  (`artifactStore.ts` ~line 685–705 on `origin/main`) re-transpiles at the **mounted** path
  (plain) → bytes differ → `discardAll()` → `tampered: true`.
- What the refresh code is (checked in grove's zip for `a11354341d02…`,
  `.immediately.run/artifacts/transpiled/src/components/GroveNav.tsx.js`, 29 666 bytes):
  - an **outer envelope**: `var _csbRefreshUtils = require("/node_modules/__csb_bust/refresh-helper.js"); var prevRefreshReg = window.$RefreshReg$; … _csbRefreshUtils.prelude(module); try { … _csbRefreshUtils.postlude(module); } finally { window.$RefreshReg$ = prevRefreshReg; window.$RefreshSig$ = prevRefreshSig; }`
  - **inner registrations** from `react-refresh/babel`: `_s = $RefreshSig$()`, `_s()` in the
    component body, `_c = GroveNav; $RefreshReg$(_c, "GroveNav")`;
  - and the extra dep `/node_modules/__csb_bust/refresh-helper.js` in the index entry's `deps`.
  The plain (library-path) compile of the same source is 26 260 bytes with none of it.
- It is **not tampering**: transpiler 0.9.1 (sandbox's exact pin) at `/app/src/components/GroveNav.tsx`
  reproduces the shipped artifact byte-for-byte.
- **The output is path-independent apart from the chain choice**: the inline source map's
  `sources` is the basename only (`["GroveNav.tsx"]`), no `file`/`sourceRoot`. So compiling
  at *any* `/node_modules/<name>/<rel>` yields the same bytes as the in-browser compile at
  the actual mount path, even if the consumer mounts the library under a different name.
  (Confirm this with a test — see B.4.)
- Why it surfaced now: R3-1331 gave grove's pinned commits zips with artifacts (grove's
  cache.yml keep-set), so library artifacts started being consumed.
- Origin (R3-1343's `### Origin`): sandbox `a108ac8` (#78, 2026-08-19, no item) put library
  modules into the spot-verify universe; `spec-silent` (neither `LIBRARY_MOUNTS_SPEC` §3
  step 4 nor `PRETRANSPILED_ARTIFACTS_SPEC` §5.7 says which path a library module is
  transpiled at); missed by `no-review`; class `gate-tried-on-one-shape`.

## The plan

### A. Sandbox — this PR, reworked (one repo, no publish; ships alone and ends the false alarm)

1. **Revert** `publisherPathFor` and its call in `spotVerify`; `spotVerify` keeps
   re-transpiling at the **mounted** path (`appModulePath`), which is the correct
   reference under ruling 1.
2. **Seeding a library root** (`seedRoot` for any root other than `APP_ROOT`): for each index
   entry,
   - if the entry has a `library` variant (`entry.library = { out, deps }`, see B.2) →
     seed **that** (`out`/`deps` from the variant; same `validateSeedEntry` rules: `out`
     confined to `.immediately.run/artifacts/`, `srcSha` from the parent entry, manifest +
     dirty-set checks);
   - else, if the module's chain is the same at both paths (today: plain `.ts`, i.e.
     `selectReactChain('/app'+p).variant === selectReactChain(mountedPath).variant` — use the
     transpiler's own `selectReactChain`, never a copied regex) → seed the entry as now;
   - else (a refresh-variant `.tsx/.jsx/.js` with no library variant — every zip built
     today) → **do not seed**; the module transpiles live. This is a cache miss, never a
     distrust. Count it in the seed diagnostics (e.g. `libraryVariantMissing: n`) so the
     perf log shows why a library is cold.
   - The `/app` root is unchanged.
3. Put the per-entry decision in a pure exported function (e.g.
   `selectSeedVariant(entry, { isAppRoot, appPath, mountedPath })` in `artifactIndex.ts`)
   so it is unit-testable without ZenFS.
4. Index validation (`artifactIndex.ts` `isFileEntry`/`validateIndex`): unknown keys are
   already tolerated, so old sandboxes ignore `library`. In the new code, a **malformed**
   `library` (not `{ out: string, deps: string[] }`) must reject only that entry's variant
   (fall back to "do not seed" for a refresh-variant file), **never** the whole index —
   remember R3-843, where one bad entry poisoned every artifact.
5. Tests (replace this PR's `artifactSpotVerifyLibraryRoot.test.ts` cases):
   - a library-root `.tsx` with only the `/app` (refresh) artifact is **not seeded**, the
     module transpiles live, and a first-idle `spotVerify` returns `tampered: false`
     (fails on `origin/main`, where it is seeded and the spot-check distrusts);
   - a library-root `.tsx` **with** a `library` variant built by the real transpiler at a
     `/node_modules/…` path is seeded from the variant and passes `spotVerify` at the
     mounted path, **with the mount name different from the one it was built under**;
   - a library `.ts` (plain at both paths) is still seeded from the base entry;
   - a tampered `library` variant is still caught (`tampered: true`);
   - a malformed `library` field rejects only that file, the rest of the index seeds;
   - keep the fixture guard that the `/app` and `/node_modules` compiles of the `.tsx`
     really differ, so no case passes vacuously.
6. Spec: amend `PRETRANSPILED_ARTIFACTS_SPEC` §5.1 (seeding a library root) and §5.7
   (the spot-check reference is the mounted-path compile; a missing library variant is a
   cache miss) — or leave that to the item in B and say so in the PR.

### B. CLI + config + spec — a NEW roadmap item (file it with `claim.sh new`; `depends_on` none; publish-gated)

1. **Config key**: `libraryArtifacts: true` in the repo's immediately.run config, read by
   the CLI the same way it reads `resolveFromRegistry`
   (`immediately-run-cli:src/commands/cacheZip.ts` `headRegistryResolved`, ~line 170 — from
   `HEAD:package.json#immediately.run`; also accept `immediately.run.json` at the repo root
   if the CLI already reads it — check). Add the key to the config schema
   (`immediately-run-site-main/public/immediately-run-config.schema.json`; find its
   generator — `src/generated/immediately-run-config.schema.json` — and change the source).
   The name is a suggestion; the owner said only "a property of the repository that can be
   enabled in immediately.run JSON".
2. **Emission**: in `emitArtifacts`, when the flag is set, for each transformable file whose
   chain differs between `/app/<rel>` and `/node_modules/<pkg>/<rel>` (use
   `selectReactChain`), transform again at `/node_modules/<package.json name>/<rel>` and
   write `transpiled-lib/<rel>.js` (or similar, under `.immediately.run/artifacts/`); record
   `files[path].library = { out, deps }` (extend `ArtifactIndexFileEntry` with an optional
   `library?: { out: string; deps: string[] }`). Apply the same R3-843 dep check to the
   variant. Files whose chain is the same at both paths get no variant (the base serves).
3. `schemaVersion` stays `1` (additive, ignored by old consumers) — confirm against §4.2's
   forward-compat rule.
4. Tests: the variant's bytes equal `transformFile({ path: '/node_modules/x/<rel>' })` and
   equal it again under a **different** `/node_modules/y/` name (proves path independence);
   no variant without the flag; `.ts` gets no variant; `.mdx` gets none (see Out of scope).
5. Publish: bump + merge → OIDC publish (memory `npm-trusted-publishing`); then the zip
   workflow must use the new CLI (check how `zip-cache.yml` / `cache.yml` pins the CLI —
   R3-1332 is moving it to a shared `new-project-template` workflow; coordinate).
6. Spec `PRETRANSPILED_ARTIFACTS_SPEC`: §4.2 (the `library` field), §7 (CLI emission + the
   flag), and a new `### D-PTA-6` in `## Decisions & rejected alternatives` recording the
   owner's three rulings above, with the rejected alternative "verify library artifacts at
   the publisher path `/app`" (this PR's first version) and why.

### C. Grove opts in

After B ships: set `libraryArtifacts: true` in grove's `package.json#immediately.run`, merge,
and let grove's cache workflow rebuild its zips (grove is consumed at pinned commits, so the
*pinned* commit must be one built with the flag — check how baton-board pins grove).

### D. Live check

R3-1323 already carries the leg (added 2026-11-05): after deploy, a cold load of
`…/baton/main/bundle/tickets/` shows no `transpile-mismatch` warning and no notification. After
C, add: the `[ir-perf]`/seed diagnostics show grove's library artifacts seeded (non-zero),
not compiled live.

## Out of scope / known gaps (record, don't fix here)

- Library `.mdx`: the transpiler compiles no `.mdx` under `/node_modules/` (`MDX_APP_ROOT_RE`),
  so library `.mdx` stays live; no variant is emitted.
- `discardAll` on a mismatch drops the app's own artifacts too, while §5.7 says "discard for
  the mount" — a spec-vs-code question noted in R3-1343's Hand-off; not this change.
- Neither `appReady` nor the perf timeline resets on a same-listener frame reload
  (site-main; unrelated, noted on R3-1342).
- A browser that already recorded the distrust mark for baton `284da70` keeps it until baton's
  `main` moves.

## State at hand-off

- Roadmap: R3-1343 `in-review` with this PR in `prs:`. The rework session should
  re-scope R3-1343 to step A (`claim.sh set R3-1343 --status in-progress --note "owner
  rulings 2026-11-06: …; rework per HANDOVER-R3-1343.md"`) and file step B as a new item.
- This PR: open, unmerged, review gate **not run**. Its current code implements the rejected
  direction — do not merge it as is.
- Related: R3-1340 (baton#185, the blank tickets page) and R3-1342 (deep links, done,
  site-main#778) are the other two causes behind the owner's "I can't see tickets" report.
- Memories worth reading first: `pretranspiled-artifact-consumption-broken`,
  `babel-worker-packaging`, `zip-cache-automation-spec`, `npm-trusted-publishing`,
  `publish-gated-cross-repo-chain`, `artifact-age-vs-page-load`, `resolvability-is-not-correctness`.
