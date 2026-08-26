/**
 * The frame-side mount-admission gate (R3-352; HOST_ORIGIN_HARDENING_SPEC §2.4,
 * UI_AS_APPS_SPEC §8.7 / threat T4).
 *
 * The sandbox mounts everything into ONE unified namespace with no path
 * normalization, so a mount announced at a crafted path can SHADOW a path the
 * bundler already owns — `/app` (the repo root the evaluator reads) or
 * `/node_modules` (every bare import). Shadowing `/app` means the next compile
 * evaluates whatever the announcer served, inside this frame's realm and with
 * this frame's grants: the mount path is therefore an authority-bearing field,
 * not a cosmetic one.
 *
 * The host validates its own mount paths at the export chokepoint
 * (site-main `filesystem/mountPath.ts`), but that check lives on the other side
 * of a trust boundary. This module is the frame's independent gate — the
 * "defense in depth crosses the trust boundary" rule (ways_of_working §2)
 * applied to the mount table.
 *
 * `handleMountAdd` and `handleRepoMount` both route through here so the two
 * cannot drift into parallel, differently-strict copies of the same rule
 * (ways_of_working §5, "one resolution entry point per concern"); before R3-352
 * only `handleRepoMount` validated anything at all.
 */

/**
 * The roots the HOST is allowed to announce a mount under. Everything the host
 * publishes today lands in one of these two:
 *
 * - `/mnt/{hash}` — every `mountPublisher.add` whose path comes from
 *   `mountPathFromId()`: spaces, working trees, content corpora, settings,
 *   git-library mounts (site-main `filesystem/mountUri.ts`).
 * - `/task/{slot}/{paramKey}[/{i}]` — the §5.7 task file-delegation chroots
 *   (site-main `editor/task/taskDelegation.ts`).
 *
 * Adding a root here is a deliberate widening of what a message can shadow;
 * `/app` and `/node_modules` are reserved to the bundler and are unreachable
 * through this list by construction rather than by a denylist (a denylist is
 * only as good as its enumeration — `/app/../app`, `/APP`, a future third
 * bundler-owned path).
 */
export const HOST_MOUNT_ROOTS = ['mnt', 'task'] as const;

/** The repo dual-mount (§11.2) is narrower still: only the canonical `/mnt/{hash}`. */
export const REPO_MOUNT_ROOTS = ['mnt'] as const;

/** A single path segment is a plain name — no separators, traversal, empty, or NUL.
 *  Mirrors the host-side `isSafeMountSegment` (site-main `filesystem/mountPath.ts`). */
function isPlainSegment(segment: string): boolean {
  return (
    segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\0')
    // `split('/')` already guarantees no embedded separator.
  );
}

/**
 * True iff `path` is a mount path this frame will honor: an absolute, NUL-free,
 * already-normalized path (`/a/b`, never `/a//b`, `/a/../b`, `a/b`, or bare `/`)
 * that is strictly BELOW one of `roots`.
 *
 * "Strictly below" — at least two segments — is deliberate: `/mnt` or `/task`
 * itself is not a mount point anyone publishes, and mounting there would shadow
 * the whole namespace the other mounts live in. (It also preserves the exact
 * strictness of the `path.startsWith('/mnt/')` test this replaced in
 * `handleRepoMount`.)
 *
 * Rejects, among others: `/app`, `/node_modules/react`, `/mnt/../app`, `/mnt`,
 * `/`, `//app`, `''` — and does so identically whether the message came from the
 * parent or from a forging sibling frame. A parent-sent violation is a host bug
 * and is logged loudly by the caller rather than honored.
 */
export function isAllowedMountPath(path: unknown, roots: readonly string[] = HOST_MOUNT_ROOTS): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path[0] !== '/' || path.includes('\0')) return false;
  const segments = path.split('/').slice(1); // drop the leading "" before "/"
  if (segments.length < 2) return false;
  if (!segments.every(isPlainSegment)) return false;
  return roots.includes(segments[0]);
}

/** Why a `mount-add` was refused — the log/test-visible reason, never a mount. */
export type MountRefusal = 'no-descriptor' | 'no-port' | 'path-outside-namespace';

export type MountAdmission =
  | { ok: true; path: string; port: MessagePort }
  | { ok: false; reason: MountRefusal; path?: unknown };

/**
 * Decide whether a `mount-add` message may be mounted, and hand back the pieces
 * the handler needs. Pure — no mounting, no logging, no globals — so the
 * adversarial tests drive the REAL admission code rather than a restatement of
 * it (ways_of_working §5: the decision lives outside the framework shell that
 * performs it).
 *
 * A refusal is terminal: the caller closes the transferred port and returns. It
 * never falls through to a "well, mount it somewhere else" path — the whole
 * point of the gate is that an unnameable path stays unnameable.
 */
export function admitMountAdd(message: {
  mount?: { path?: unknown } | null;
  ports?: readonly MessagePort[] | null;
}): MountAdmission {
  const descriptor = message?.mount;
  if (!descriptor) return { ok: false, reason: 'no-descriptor' };
  const port = message?.ports && message.ports[0];
  if (!port) return { ok: false, reason: 'no-port' };
  const path = descriptor.path;
  if (!isAllowedMountPath(path, HOST_MOUNT_ROOTS)) {
    return { ok: false, reason: 'path-outside-namespace', path };
  }
  return { ok: true, path, port };
}
