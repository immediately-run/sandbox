/**
 * The `fs-change` wire message (R3-274e).
 *
 * PLATFORM_LAYERING_SPEC §2 names this the exemplar divergence: the host sends
 * `{paths, epoch}` (`site-main/src/registry/channelBridge.ts`), this frame read only
 * `paths`, the SDK read both — and **neither side declared a type**, so the protocol
 * snapshots recorded two different field lists for one wire name with nothing able to
 * notice. A shape nobody writes down is a shape both sides are free to be wrong about.
 *
 * So it is written down, here, on the side that receives it. `epoch` is declared even
 * though this frame does not consume it: the DECLARATION describes the message, not the
 * reader's appetite for it. (This frame recompiles on every batch, so it has no use for
 * an ordering token; the SDK's `onFsChange` consumers do.)
 */
import { FS_CHANGE } from '../generated/protocol';

export interface FsChangeMessage {
  type: typeof FS_CHANGE;
  /** Repo-relative paths (leading slash) that just changed in the working tree. */
  paths: string[];
  /** Monotonic batch counter — lets a consumer order or coalesce batches. */
  epoch: number;
}
