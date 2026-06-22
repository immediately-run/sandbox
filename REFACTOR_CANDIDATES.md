# REFACTOR_CANDIDATES — `sandbox`

Dim-3 (complexity / code-smell) notes from the 2026-06 code-verification pass
(`docs/plans/code-verification/03-sandbox.md`, parent R3-124).

> **RECORD ONLY — nothing in this file was refactored.** These are starting points for
> a *future* refactor task, written specifically enough to begin from. Each carries the
> smell, why it matters, and the risk.

---

### R1 — `SandpackInstance` god-class in `src/index.ts`

- **Path:** `src/index.ts` — `class SandpackInstance` (declared ~line 63, ~560 LOC; file
  is 620 lines).
- **Smell:** single class owns at least five distinct responsibilities:
  1. **Bootstrap / init** (`constructor`, `init`, `announceHandshake`, init-config
     consumption, SDK integrity, region surfacing, fs hydration);
  2. **Parent message routing** (`handleParentMessage` — a `switch` over
     `request-handshake`/`fs-change`/`mount-add`/`mount-remove`/`repo-mount`/`refresh`);
  3. **Mount lifecycle** (mount-add/remove handlers, `handleRepoMount` dual-mount);
  4. **Resize** (`initResizeEvent`, polling timer, height diffing);
  5. **Compile/eval orchestration + dispose**.
- **Why it matters:** the mixed concerns make each path hard to test in isolation and
  raise the blast radius of any change to one concern (e.g. resize timer logic sits
  beside protocol routing). It is the natural "front door" everyone edits, so it accretes.
- **Risk of refactor:** **high** — it is the live boot/message hub on the opaque-origin
  protocol path; splitting it touches handshake ordering (`register-frame` must precede
  the `data.codesandbox` guard), port transfer, and mount timing. Any refactor needs the
  `src/bundler/testHarness/` booted-Bundler harness green plus a manual boot smoke test.
- **Suggested direction (for the future task, not done here):** extract a
  `ParentMessageRouter` (the `switch`), a `MountController` (mount-add/remove/repo-mount),
  and a `ResizeReporter` (the polling timer), leaving `SandpackInstance` as the
  composition root. Keep wire ordering identical.

---

### R2 — (observed, low priority) duplicated "absent until the host wires delivery" init fields

- **Path:** `src/protocol/iframe.ts:39-56` (the `register-frame` → `IInitConfig` field
  copy) and `src/protocol/message-types.ts:10-44` (the `IInitConfig` shape).
- **Smell:** the set of optional boot fields (`sdkIntegrity`, `dirtyPaths`,
  `distrustArtifacts`, `fsSnapshot`, `region`) is hand-copied field-by-field from
  `data.*` into `config`, each with a near-identical "absent until the host wires
  delivery" comment. Adding a field means editing two places in lockstep.
- **Why it matters:** low-grade drift risk (a field added to the type but not copied, or
  vice-versa) — exactly the kind of thing the Gate-2 boot-wiring will keep extending.
- **Risk of refactor:** **low**, but not zero — the explicit copy is also a small
  allow-list (only known fields cross). A future tidy could derive the copy from a keyed
  list while preserving the allow-list property. Not worth doing speculatively; noted so a
  later boot-wiring change can fold it in.
