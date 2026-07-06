/**
 * Source-control ("vcs") state mirrored from the parent window into the sandbox
 * (UI_AS_APPS_SPEC §5.3 Recipe A; migrate-sidebars-to-apps Phase 05). The parent
 * (immediately.run host) derives the working-tree diff summary, the branch lineage
 * (§15.1), and the open-PR list from authenticated GitHub calls + the COW layers,
 * and relays them as a `vcs-state` message; the sandbox caches it (see
 * `VcsService`) so a first-party contribute panel (`panel.contribute`, Phase 06)
 * can render parity with the native `SourceControlPanel`.
 *
 * ELEVATED capability `vcs:read`: the parent's channel ACL withholds the whole
 * message from any iframe lacking `vcs:read`, so a baseline/previewed app never
 * sees it. The payload is plain JSON — no `DiffResult` / `FileSystem` / OAuth token
 * ever crosses the boundary (§8.10).
 */

/** One changed path in the working tree (vs. the loaded ref). */
export interface VcsChange {
  /** Repo-relative path. */
  path: string;
  status: 'created' | 'modified' | 'deleted';
}

/** The branch the working tree sits on + the upstream it diverged from (§15.1).
 *  `null` until the user is on a immediately.run-created branch. */
export interface VcsBranch {
  name: string;
  parentRepo: string;
  parentRef: string;
  parentCommitSha: string;
  /** `null` while push access is still being probed. */
  upstreamPushable: boolean | null;
}

/** One pull request open from the current branch. */
export interface VcsPR {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
}

/** The whole source-control snapshot the parent projects to a `vcs:read` frame. */
export interface VcsState {
  changes: VcsChange[];
  branch: VcsBranch | null;
  prs: VcsPR[];
  /** True while the host is recomputing the diff (the panel shows a spinner). */
  diffLoading: boolean;
}

/** Assumed before the parent has reported (also the value a non-`vcs:read` app
 *  keeps forever): nothing changed, no branch, no PRs. */
export const DEFAULT_VCS_STATE: VcsState = {
  changes: [],
  branch: null,
  prs: [],
  diffLoading: false,
};

/** Identity message the parent sends to push the current source-control state. */
export const VCS_STATE_MESSAGE = 'vcs-state';

/** Sent by the sandbox once registered, asking the parent to reply with state. */
export const REQUEST_VCS_STATE_MESSAGE = 'request-vcs-state';

/** A `vcs-state` push message from the parent (untrusted — validate on receipt). */
export interface VcsStateMessage {
  type: typeof VCS_STATE_MESSAGE;
  changes: VcsChange[];
  branch?: VcsBranch | null;
  prs?: VcsPR[];
  diffLoading?: boolean;
}

const changesEqual = (a: VcsChange[], b: VcsChange[]): boolean =>
  a.length === b.length && a.every((c, i) => c.path === b[i].path && c.status === b[i].status);

const prsEqual = (a: VcsPR[], b: VcsPR[]): boolean =>
  a.length === b.length &&
  a.every((p, i) => p.number === b[i].number && p.state === b[i].state && p.draft === b[i].draft);

const branchesEqual = (a: VcsBranch | null, b: VcsBranch | null): boolean => {
  if (a === null || b === null) return a === b;
  return (
    a.name === b.name &&
    a.parentRepo === b.parentRepo &&
    a.parentRef === b.parentRef &&
    a.parentCommitSha === b.parentCommitSha &&
    a.upstreamPushable === b.upstreamPushable
  );
};

/** True when two states are equal (used to suppress no-op change events). */
export const vcsStatesEqual = (a: VcsState, b: VcsState): boolean =>
  a.diffLoading === b.diffLoading &&
  branchesEqual(a.branch, b.branch) &&
  changesEqual(a.changes, b.changes) &&
  prsEqual(a.prs, b.prs);
