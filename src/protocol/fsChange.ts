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

/** The fields the working-tree admission rule reads. Tied to {@link FsChangeMessage}
 *  so renaming one on the wire breaks this build rather than silently reading
 *  `undefined` here — the whole point of this file. Both are optional because an
 *  older host may omit them, and the rule tolerates that at runtime too. */
export type FsChangeAdmissionInput = Partial<Pick<FsChangeMessage, 'paths' | 'epoch'>>;

export type FsChangeVerdict =
  | { apply: true; epoch: number | undefined }
  | { apply: false; reason: 'empty' | 'duplicate-epoch' };

/**
 * Whether a working-tree `fs-change` batch should be applied (invalidate +
 * recompile) or ignored. Pure; {@link FsChangeGate} owns the memory.
 *
 * This frame recompiles on every batch it accepts, and a full recompile of a real
 * corpus is ~600ms — so accepting a batch it has ALREADY applied is not a wasted
 * tick, it is a feedback loop waiting for a partner. It had one: site-main's
 * channel router replayed the cached `fs-change` to a frame on every re-register,
 * the recompile's `done`/`state` landed in the host's Sandpack state, the host
 * re-rendered, re-registered, and replayed again. One keystroke in the editor put
 * a production preview into ~7 full compiles per second, permanently (2026-09-01).
 *
 * ## Why a dropped batch is expensive, and an extra compile is not
 *
 * `markFilesChanged` is the ONLY thing that evicts `CachedFS`'s content caches and
 * fills `pendingChanges`, and `compile()` drives re-transformation off
 * `drainPendingChanges()` alone — short-circuiting entirely when it is empty. So a
 * path dropped from a batch is never re-transformed by any LATER compile either:
 * it stays at its old compiled output until that same path appears in a batch we
 * accept. A false drop is therefore durable staleness — if it was the user's last
 * edit before they stopped typing, the preview stays wrong indefinitely — while a
 * false accept costs one recompile. Every rule below is asymmetric on purpose.
 *
 * ## Why the duplicate test is EQUALITY and not `epoch <= lastApplied`
 *
 * Because the host legitimately delivers an OLDER batch after a newer one, so
 * "went backwards" does not imply "already seen". `ChannelRouter.deliver` queues a
 * payload while the frame is not `ready()`, but `frame.ready` reads a ref assigned
 * during RENDER while `flush()` runs in a later effect — so a push landing in that
 * window is dispatched directly (newer epoch, applied) while the older batch is
 * still queued and arrives on the following `flush`. An ordering guard drops that
 * older batch, and by the paragraph above its paths then go durably stale.
 * Equality drops only an exact repeat, which is the only thing that feeds the loop.
 *
 * (An earlier draft of this comment justified equality by claiming the host's
 * counter — a `useRef(0)` in `SandboxListener` — could restart while this frame
 * lived on. That is FALSE, and the correction is worth recording: both
 * `SandboxListener` render sites are unconditional descendants of a **keyed**
 * `SandpackProvider` that owns the client and the iframe, so a listener remount
 * tears this frame down with it and the counter and the frame share a lifetime.
 * The conclusion survived; the reason did not.)
 *
 * Everything unrecognised fails towards APPLYING: a host that sends no `epoch`, or
 * a non-numeric one, gets the old behaviour.
 */
export function decideWorktreeBatch(
  message: FsChangeAdmissionInput,
  lastAppliedEpoch: number | undefined,
): FsChangeVerdict {
  const paths = Array.isArray(message.paths) ? message.paths : [];
  // Nothing changed: `markFilesChanged([])` invalidates nothing, and the compile it
  // would schedule reaches "no changes detected" — after paying for a START/DONE
  // round trip and a whole-registry `state` message.
  if (paths.length === 0) return { apply: false, reason: 'empty' };

  const epoch = typeof message.epoch === 'number' && Number.isFinite(message.epoch) ? message.epoch : undefined;
  if (epoch !== undefined && epoch === lastAppliedEpoch) {
    return { apply: false, reason: 'duplicate-epoch' };
  }
  return { apply: true, epoch };
}

/**
 * The working-tree `fs-change` admission gate: {@link decideWorktreeBatch} plus the
 * one piece of state it needs. Separated from the frame so the ADMISSION BEHAVIOUR
 * — not just the arithmetic — is reachable from a test; the message handler owns a
 * `SandpackInstance`, which is constructed at module scope and cannot be driven
 * from one.
 */
export class FsChangeGate {
  private lastAdmittedEpoch: number | undefined;

  /** True ⇒ apply this batch (invalidate + recompile). Records the epoch it admits. */
  admit(message: FsChangeAdmissionInput): boolean {
    const verdict = decideWorktreeBatch(message, this.lastAdmittedEpoch);
    if (!verdict.apply) return false;
    // Remember only a USABLE epoch. Writing `undefined` back would erase the memory,
    // so the next replay of an already-applied batch would compare against nothing
    // and be applied — re-opening the loop after a single epoch-less batch from an
    // older host. Keeping the last known-good epoch instead costs, at worst, one
    // extra compile for a genuinely new batch that happens to reuse it.
    if (verdict.epoch !== undefined) this.lastAdmittedEpoch = verdict.epoch;
    return true;
  }
}
