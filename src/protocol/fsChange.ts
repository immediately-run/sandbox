/**
 * The `fs-change` wire message (R3-274e).
 *
 * PLATFORM_LAYERING_SPEC §2 names this the exemplar divergence: the host sends
 * `{paths, epoch}` (`site-main/src/registry/channelBridge.ts`), this frame read only
 * `paths`, the SDK read both — and **neither side declared a type**, so the protocol
 * snapshots recorded two different field lists for one wire name with nothing able
 * to notice. A shape nobody writes down is a shape both sides are free to be wrong about.
 *
 * So it is written down, here, on the side that receives it. `epoch` is declared even
 * though this frame does not consume it: the DECLARATION describes the message, not the
 * reader's appetite for it. (This frame recompiles on every batch, so it has no use for
 * an ordering token; the SDK's `onFsChange` consumers do.)
 *
 * R3-409 adds the mount-anchored leg: a SPACE mount's server-side changes (another
 * tab's or member's writes, relayed by the host's export) arrive as `mount` instead of
 * the working-tree `paths`. The two legs are disjoint — `paths` is the editor-relative
 * working-tree batch (this frame recompiles on it); `mount` is a per-mount batch this
 * frame turns into ZenFS watch events, because zenfs's Port backend cannot forward
 * them itself. Same lesson as `epoch`: both fields are declared on ONE shape whether
 * or not a given reader consumes both.
 */
import { FS_CHANGE } from '../generated/protocol';

/** One server-side change in a mount batch: the path (mount-relative, leading
 *  slash) and its kind — the Node `watch` event mapping is `add`/`remove` →
 *  `rename`, `change` → `change`. */
export interface MountChange {
  path: string;
  kind: 'add' | 'change' | 'remove';
}

export interface FsChangeMessage {
  type: typeof FS_CHANGE;
  /** Repo-relative paths (leading slash) that just changed in the working tree. */
  paths: string[];
  /** Monotonic batch counter — lets a consumer order or coalesce batches. */
  epoch: number;
  /**
   * R3-409 — a SPACE mount's server-side change batch (another tab's/member's
   * writes), anchored at the mount path the frame holds. Absent on the
   * working-tree leg; when present, `paths` is empty.
   */
  mount?: {
    /** The sandbox mount root the `changes[].path`s are relative to (e.g. `/mnt/{hash}`). */
    path: string;
    changes: MountChange[];
  };
}
