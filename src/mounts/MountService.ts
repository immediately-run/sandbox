import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import {
  SandboxMount,
  MountChange,
  MountRemoveReason,
  RemovedMount,
  mountKey,
  mountListsEqual,
} from './mountState';

/**
 * Caches the set of mounts currently available to the sandbox and exposes it to
 * app code (through the bundler, via the SDK).
 *
 * Pure descriptor cache + change notification — it deliberately knows nothing
 * about ZenFS. The actual `mount()` / `umount()` of the transferred port lives
 * in `SandpackInstance` (which owns the zenfs imports); it calls `add`/`remove`
 * here once the filesystem side is in place. This mirrors `AuthService` and
 * keeps the service trivially unit-testable.
 *
 * Access patterns match the SDK surface:
 *  - `getMounts()` — a pollable snapshot of the current mounts.
 *  - `onChange(listener)` — fires on every change and immediately replays the
 *    current list to a new listener, so late subscribers (app code boots well
 *    after the iframe registers) don't miss mounts that already appeared.
 */
export class MountService {
  private mounts: SandboxMount[] = [];
  private changeEmitter = new Emitter<MountChange>();

  /** Add (or replace, by key) a mount and notify listeners. */
  add(mount: SandboxMount): void {
    const key = mountKey(mount);
    const next = [...this.mounts.filter((m) => mountKey(m) !== key), mount];
    this.setMounts(next, []);
  }

  /** Remove a mount by its key (`id`, falling back to `path`) and notify listeners.
   *  `reason` (AM2-4) is surfaced on the removed descriptor delivered to listeners
   *  so app code can say *why* the filesystem vanished; defaults to `'revoked'`. */
  remove(keyOrPath: string, reason: MountRemoveReason = 'revoked'): void {
    const removed: RemovedMount[] = this.mounts
      .filter((m) => mountKey(m) === keyOrPath)
      .map((m) => ({ ...m, reason }));
    this.setMounts(
      this.mounts.filter((m) => mountKey(m) !== keyOrPath),
      removed,
    );
  }

  private setMounts(next: SandboxMount[], removed: RemovedMount[]): void {
    if (mountListsEqual(this.mounts, next)) {
      return;
    }
    this.mounts = next;
    this.changeEmitter.fire({ mounts: next, removed });
  }

  /** Pollable snapshot of the current mounts. */
  getMounts(): SandboxMount[] {
    return this.mounts;
  }

  /**
   * Subscribe to mount changes. The listener is invoked immediately with the
   * current list, then again on every change. The optional second argument
   * carries the descriptors REMOVED by that change (each with its `reason`, AM2-4)
   * — empty on the initial replay and on add/replace changes. Returns a disposable.
   */
  onChange(listener: (mounts: SandboxMount[], removed: RemovedMount[]) => void): IDisposable {
    const disposable = this.changeEmitter.event((c) => listener(c.mounts, c.removed));
    listener(this.mounts, []);
    return disposable;
  }
}
