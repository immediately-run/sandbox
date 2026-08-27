/**
 * Applying one `mount-add` to the mount table — and, in particular, what to do when the
 * announcement it carries has already been SUPERSEDED (R3-284).
 *
 * ## The shape of the bug this closes
 *
 * Every dispatched boot printed, once, a red
 *
 *     Exception: mount revoked — access forbidden (FILE_SHARING §6.1)
 *
 * It reads like a grant failure. It is not. The host publishes a mount by minting a
 * revocable fs port and announcing it; if the frame has not registered yet, the frame
 * queues the `mount-add` behind its readiness promise. When the frame does register it
 * sends `request-mounts`, and the host's replay **closes every previously minted port for
 * that mount before announcing again** — so by the time the queued first announcement is
 * drained, its port has been deliberately revoked and the host's rejector answers its first
 * RPC with a terminal `EACCES`. The second announcement then mounts cleanly and the app
 * renders.
 *
 * In other words the host is doing exactly what FS2-4 / `FILE_SHARING §6.1` designed it to
 * do — answer a revoked port instead of letting the consumer hang — and the frame was
 * meeting that designed answer with `logger.error`. A `forbidden` that fires on every
 * healthy boot trains readers to ignore `forbidden`, which is the opposite of what the
 * word is for.
 *
 * ## Why this module exists rather than a `try/catch` in the handler
 *
 * Nothing today pins the property that makes the race benign: the resolve happens BEFORE
 * the `umount`/`mount` pair, so a stale announcement cannot tear down the live mount at
 * that path. Move the teardown up and the same race starts unmounting a good mount — with
 * no test to catch it, because the ordering was an accident of how the handler was written
 * rather than a stated rule.
 *
 * So the sequence is a decision with injected effects: the ordering, and the early return
 * on a superseded announcement, are asserted directly (`mountSequence.test.ts`) instead of
 * inferred from the order of statements in a 100-line method.
 */

/** The mount-table effects `applyMountAdd` drives, injected so the ordering is testable. */
export interface MountSequenceOps<FS> {
  /** Open the announced port and build its filesystem (`resolveMountConfig`). MUST be the
   *  first thing that happens: it is what makes a superseded announcement detectable
   *  before anything in the mount table is touched. */
  resolve: () => Promise<FS>;
  /** Drop whatever is mounted at this path (a no-op when nothing is). */
  umount: (path: string) => void;
  /** Create the mount point directory if it does not exist. */
  materialize: (path: string) => Promise<void>;
  /** Attach the filesystem at the path. */
  mount: (path: string, fs: FS) => void;
  /** Close the announced port when we are not going to use it. */
  closePort: () => void;
}

export type MountAddOutcome =
  /** The filesystem is attached at `path`. */
  | { status: 'mounted' }
  /**
   * The announcement was superseded before we drained it: its port had already been
   * revoked and replaced by the host's `request-mounts` replay. Nothing in the mount table
   * was touched — including any GOOD mount already serving at this path.
   */
  | { status: 'superseded' };

/**
 * Is this error the host telling us "that port is gone" rather than a real failure?
 *
 * Deliberately narrow. `EACCES` from the first RPC on a freshly announced port is the
 * FS2-4 rejector's terminal reply, and it is the only error that means *superseded*.
 * `ENOENT` — which the same channel emits by the thousand during ordinary module
 * resolution — is not a revocation and must stay loud if it ever reaches here, and so must
 * a timeout, a transport failure, or anything unrecognised.
 *
 * Matched on the error's `code` first (what ZenFS sets) and on the message only as a
 * fallback, so a wrapper that loses the property but keeps the text is still recognised —
 * while a message that merely CONTAINS the word "access" is not: the token has to be there.
 */
export function isSupersededAnnouncement(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') return code === 'EACCES';
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && /\bEACCES\b/.test(message);
}

/**
 * Apply one `mount-add` for `path`.
 *
 * The order is the contract, not an implementation detail:
 *
 *   1. resolve the announced port — a superseded announcement fails HERE,
 *   2. …and returns, so 3–5 never run,
 *   3. umount whatever is at the path,
 *   4. materialize the mount point,
 *   5. mount.
 *
 * Any error that is not a supersession propagates unchanged, so a genuine revocation
 * mid-session, a transport fault, or a timeout still surfaces loudly.
 */
export async function applyMountAdd<FS>(path: string, ops: MountSequenceOps<FS>): Promise<MountAddOutcome> {
  let fs: FS;
  try {
    fs = await ops.resolve();
  } catch (err) {
    if (!isSupersededAnnouncement(err)) throw err;
    // The host already closed this port; closing our end too is idempotent and leaves no
    // half-open channel behind.
    try {
      ops.closePort();
    } catch {
      /* already closed */
    }
    return { status: 'superseded' };
  }
  // Re-mounting the same path: drop the previous mount first.
  try {
    ops.umount(path);
  } catch {
    /* not previously mounted — fine */
  }
  await ops.materialize(path);
  ops.mount(path, fs);
  return { status: 'mounted' };
}
