# DEPRECATION_CANDIDATES — `sandbox` (inherited-but-unused upstream surface)

Dim-4 inventory from the 2026-06 code-verification pass
(`docs/plans/code-verification/03-sandbox.md`, parent R3-124). `sandbox` is a **fork of
CodeSandbox's `sandpack-bundler`**, so it carries upstream surface immediately.run never
adopted. This file catalogues that surface.

> **FLAG ONLY — nothing in this file was removed.** Each candidate carries the
> three-question test (Q1 reachable / Q2 spec-claimed / Q3 contract-wire-load-bearing).
> A candidate is recorded **only if Q1=no AND Q2=no AND Q3=no**. Surface where **Q3=yes**
> (load-bearing sandpack-protocol/runtime glue that merely *looks* legacy) is recorded in
> `CODE_SPEC_REFERENCES.md` ("KEEP"), not here. Each code site (where comments are
> possible) also carries a `// DEAD-CANDIDATE(2026-06): …` marker.

## Method recap

- **Pass A** — presets / frameworks (richest legacy vein)
- **Pass B** — transformers / loaders → **clean result, no candidates** (recorded)
- **Pass C** — CodeSandbox identity / infra / docs
- **Pass D** — unreferenced exports / files
- **Pass E** — build/config artifacts

---

## Pass A — Solid preset (the one real code-feature candidate)

### Solid framework preset (`SolidPreset` + its deps)

- **Path(s):**
  - `src/bundler/presets/solid/SolidPreset.ts` (whole file; class declared line 9)
  - `src/bundler/presets/registry.ts:4` (import) and `:8` (commented-out registration `// ['solid', new SolidPreset()]`)
  - `package.json` deps `babel-preset-solid` (line 71), `solid-refresh` (line 84)
  - `src/resolver/fixture/node_modules/solid-js/` (test fixture only)
- **What it is / upstream origin:** SolidJS support inherited from upstream Sandpack,
  which ships presets for multiple frameworks. immediately.run is **React-only** (the app
  CLAUDE.md design system + `ReactPreset` is the only live preset).
- **Q1 reachable:** **no** — `getPreset()` (`registry.ts:11`) only instantiates entries in
  `PRESET_MAP`; the `'solid'` entry is **commented out**, and any unknown preset name
  falls back to `new ReactPreset()` (`registry.ts:14-15`). `SolidPreset` is constructed on
  no live path from `src/index.ts`; reaching it requires editing source.
- **Q2 spec-claimed:** **no** — grep of `/home/user/docs/specs/` finds no spec requiring
  Solid; immediately.run targets React.
- **Q3 contract/wire-load-bearing:** **no** — it is a build-time preset, not part of the
  sandpack iframe protocol or module runtime.
- **Reason it's a candidate:** inherited-but-unused framework preset + the two npm deps it
  drags in (`babel-preset-solid`, `solid-refresh`).
- **Removal risk / note:** low risk to remove preset + deps; **may be a deliberate
  upstream-merge-lineage keep** (eases future `git merge` from upstream sandpack-bundler).
  Owner decides. If removed, also drop the two deps and the `solid-js`/`solid-refresh`
  fixture(s). Markers added at `registry.ts` and `SolidPreset.ts`.

### No other framework presets

Confirmed (Pass A): `src/bundler/presets/` contains only `react/` and `solid/` (+ the
`Preset.ts` base and `registry.ts`). **No Vue/Angular/Svelte/Preact/vanilla presets exist.**
Nothing else to flag here.

---

## Pass B — Transformers / loaders: CLEAN (no candidates)

All transform subdirs under `src/bundler/transforms/` — `asset`, `babel`, `css`, `mdx`,
`raw-cjs`, `react-refresh`, `style` — are wired into `ReactPreset`
(`src/bundler/presets/react/ReactPreset.ts`, imported in `init()` and referenced from
`mapTransformers`). **No orphaned transformers.** Recorded as a clean Phase-3 result; no
DEAD-CANDIDATE markers added here.

---

## Pass C — CodeSandbox-origin identity & docs (stale fork identity)

These are **comment-less / markdown / JSON-without-comments** files, so the record here
IS the marker (no inline `// DEAD-CANDIDATE` possible). All carry the same overarching
note: **fork-lineage identity may be a deliberate keep — owner decides; this pass only
flags.**

### Stale package identity (`package.json`)

- **Path(s):** `package.json:2` `"name": "sandpack-bundler"`, `:9` `"author": "CodeSandbox"`,
  `:11-14` `"repository.url": "https://github.com/codesandbox/sandpack-bundler"`.
- **What it is:** original upstream project identity; the immediately.run repo is
  `immediately-run/sandbox`.
- **Q1 reachable:** n/a (metadata). **Q2 spec-claimed:** no spec requires these exact
  strings (`SIMPLIFIED_DEPLOYMENT_SPEC §2` describes the actual deploy). **Q3 load-bearing:**
  **no** — `name`/`author`/`repository` do not affect the build or the wire protocol (the
  `data.codesandbox` *wire flag* is unrelated and IS load-bearing — see
  CODE_SPEC_REFERENCES.md).
- **Reason it's a candidate:** stale fork identity.
- **Removal risk / note:** changing `name` could affect any npm-name-based tooling
  (none observed); **filed as a fork-identity question, coordinated with the shared
  vocabulary/identity track (overview §6), not edited here.**

### Stale README (lower section)

- **Path:** `README.md` — the **"Sandpack Bundler"** section onward (lines ~9-34):
  references `yarn`, `https://sandpack-bundler.codesandbox.io` deploy URL,
  `sandpack-react` `bundlerURL` workflow, and an absolute local font path
  (`/Users/neumark/git/sandpack-test/...`). None match the immediately.run deploy
  (Firebase `dist/`) or toolchain (npm, not yarn).
- **Note:** the README's **top** section ("Node module caching") IS current and
  first-party — keep. Only the lower upstream-workflow half is stale.
- **Q1/Q2/Q3:** n/a / no / no. **Reason:** stale upstream docs. **Risk:** doc-only.

### `.codesandbox/tasks.json`

- **Path:** `.codesandbox/tasks.json` (whole file).
- **What it is:** CodeSandbox-workspace task definitions (`yarn install`/`yarn dev`/
  `yarn start`/`yarn build`/`yarn test`).
- **Q1 reachable:** no — not consumed by immediately.run CI (`.github/workflows/`) or the
  Firebase deploy. **Q2 spec-claimed:** no. **Q3 load-bearing:** no.
- **Reason it's a candidate:** unused CodeSandbox-IDE config.
- **Removal risk / note:** none for immediately.run; harmless to keep for anyone opening
  the repo in CodeSandbox. Owner decides.

---

## Pass D — Unreferenced exports / files

Spot-checked exported symbols for zero non-self / non-test importers. **No genuine
orphans found** beyond `SolidPreset` (already in Pass A). `index.ts`-only side-effect
modules and barrel re-exports were treated as live (not dead) per the conservative rule.
No additional candidates.

---

## Pass E — Build / config artifacts

### `server.js` (local-only Fastify prod-test server)

- **Path:** `server.js` (whole file).
- **What it is:** a Fastify static server for **local** production-build testing
  (`npm start`, port 4587), inherited from upstream.
- **Q1 reachable (in the deploy path):** **no** — the immediately.run deploy is Firebase
  Hosting serving `dist/` (`firebase.json` `hosting.public: "dist"`, SPA rewrite to
  `/index.html`); no Functions, no `server.js` invocation. `.firebaserc` confirms a pure
  hosting deploy.
- **Q2 spec-claimed:** no. **Q3 load-bearing:** **no** for production; it IS useful for
  local prod-build smoke testing.
- **Reason it's a candidate:** unused in the production/CI deploy path (local convenience
  only).
- **Removal risk / note:** removing it loses the local prod-build test convenience
  (`npm start` would break). Recommend **keep**; flagged for awareness. `// DEAD-CANDIDATE`
  marker added at the top of the file.

### `.proxyrc.json` (empty)

- **Path:** `.proxyrc.json` — contents are an empty object `{}`.
- **What it is:** a Parcel dev-proxy config with **no rules defined**.
- **Q1 reachable:** effectively no (empty → no proxy behavior). **Q2 spec-claimed:** no.
  **Q3 load-bearing:** no.
- **Reason it's a candidate:** empty inherited config; does nothing.
- **Removal risk / note:** negligible. JSON file has no comment syntax, so this entry is
  the record (no inline marker).

### Kept (live — NOT candidates)

- `.parcelrc` — live build config (extends `@parcel/config-default`, wires
  `parcel-reporter-static-files-copy`). Keep.
- `static/_headers` — copied into `dist/` by the parcel reporter; Firebase applies the
  `Cache-Control` headers. Keep.
- `firebase.json` / `.firebaserc` — the live deploy config. Keep.

---

## Cross-references

- Load-bearing sandpack-protocol/runtime glue that *looks* like CodeSandbox cruft
  (`data.codesandbox` wire flag, `__csb_runtimes/` path, `$csb$eval` wrapper, the
  `blazingly.io` CDN) is **NOT here** — it is recorded as **KEEP** in
  `CODE_SPEC_REFERENCES.md` per the Q3 carve-out.
- Complexity notes (the `SandpackInstance` god-class) are in `REFACTOR_CANDIDATES.md`.
- The `stage.conversation` wire region string and the fork-identity rename are
  **filed, not executed** — they cross repo/wire boundaries and feed the shared
  vocabulary symbol-rename track (overview §6). See the pass return / DOCS DELTA.
