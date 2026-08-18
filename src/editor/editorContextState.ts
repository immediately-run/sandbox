/**
 * Editor context mirrored from the parent window into the sandbox (UI_AS_APPS
 * §5.3). The parent (immediately.run host) relays which files the user has
 * changed-but-not-saved as an `editor-context` message; the sandbox caches it
 * (see `EditorContextService`) so a chrome app (e.g. the contribute dialog) can
 * show "you'll save these N files" before triggering a save.
 *
 * ELEVATED capability `editor:read`: the active file + ref are already baseline
 * via `route:read` (the `urlchange` channel), so this channel carries ONLY the
 * genuine delta — the dirty set. The parent's channel ACL withholds the whole
 * message from any iframe lacking `editor:read`, so a baseline app never sees it.
 */
import { EDITOR_CONTEXT, REQUEST_EDITOR_CONTEXT } from '../generated/protocol';

export interface EditorContext {
  /** Paths (repo-relative) the user has modified but not yet saved. */
  dirtyPaths: string[];
  /** The one file focused in the host editor (repo-relative, leading slash), or
   *  `null` when none is open. Carried here (not via `route:read`) so a self-routed
   *  system panel — which doesn't observe the host route — can still learn it. */
  activeFile: string | null;
}

/** Assumed before the parent has reported: nothing dirty, no active file. */
export const DEFAULT_EDITOR_CONTEXT: EditorContext = { dirtyPaths: [], activeFile: null };

/** Identity message the parent sends to push the current editor context. */
export const EDITOR_CONTEXT_MESSAGE = EDITOR_CONTEXT;

/** Sent by the sandbox once registered, asking the parent to reply with context. */
export const REQUEST_EDITOR_CONTEXT_MESSAGE = REQUEST_EDITOR_CONTEXT;

/**
 * An editor-context push message from the parent — the WIRE shape, which is the
 * host's to define (`site-main/src/registry/channelBridge.ts` builds it, and that
 * projection is a whitelist: a field not named there never crosses).
 *
 * R3-274e: this declaration used to name two of the four fields the host has been
 * sending. `openFiles` and `viewedFile` (R3-268) never entered it, so the two
 * repos' protocol snapshots disagreed about one wire name — `declared-incomplete`
 * in the R3-274a audit. Declaring the message is not the same as consuming it:
 * {@link EditorContext} below is what this frame CACHES, deliberately a subset
 * (the SDK is the side that surfaces all four to apps). Nothing about the wire
 * changes here; the declaration catches up to it.
 */
export interface EditorContextMessage {
  type: typeof EDITOR_CONTEXT_MESSAGE;
  dirtyPaths: string[];
  openFiles: string[];
  activeFile: string | null;
  viewedFile: string | null;
}

/** True when two contexts are equal (used to suppress no-op change events). */
export const editorContextsEqual = (a: EditorContext, b: EditorContext): boolean =>
  a.activeFile === b.activeFile &&
  a.dirtyPaths.length === b.dirtyPaths.length &&
  a.dirtyPaths.every((p, i) => p === b.dirtyPaths[i]);
