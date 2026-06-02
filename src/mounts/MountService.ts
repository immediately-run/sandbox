import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import { SandboxMount, mountKey, mountListsEqual } from './mountState';

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
  private changeEmitter = new Emitter<SandboxMount[]>();

  /** Add (or replace, by key) a mount and notify listeners. */
  add(mount: SandboxMount): void {
    const key = mountKey(mount);
    const next = [...this.mounts.filter((m) => mountKey(m) !== key), mount];
    this.setMounts(next);
  }

  /** Remove a mount by its key (`id`, falling back to `path`) and notify listeners. */
  remove(keyOrPath: string): void {
    this.setMounts(this.mounts.filter((m) => mountKey(m) !== keyOrPath));
  }

  private setMounts(next: SandboxMount[]): void {
    if (mountListsEqual(this.mounts, next)) {
      return;
    }
    this.mounts = next;
    this.changeEmitter.fire(next);
  }

  /** Pollable snapshot of the current mounts. */
  getMounts(): SandboxMount[] {
    return this.mounts;
  }

  /**
   * Subscribe to mount changes. The listener is invoked immediately with the
   * current list, then again on every change. Returns a disposable.
   */
  onChange(listener: (mounts: SandboxMount[]) => void): IDisposable {
    const disposable = this.changeEmitter.event(listener);
    listener(this.mounts);
    return disposable;
  }
}
