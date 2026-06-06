// Mount-lifecycle hooks (FILE_SHARING_SPEC §11.3). A RUNTIME-INTERNAL registry of
// actions that run when a filesystem is mounted into the sandbox (the app repo at
// boot, each dynamic mount on `mount-add`) and, symmetrically, before it is
// unmounted. Generalizes the formerly-hardcoded MDX-frontmatter scan so any
// post-mount behaviour (indexing, sidecar reads, …) is just another registrant.
//
// Constraints (security-sensitive — see §11.3):
//  - Actions are registered ONLY by the sandbox runtime, never by app code: an
//    action reads the mounted fs, which may belong to another trust domain.
//  - An action decides its own scope from the `MountContext` (e.g. MDX scans only
//    `isAppRoot`), so a large granted space is not recursively scanned by default.
//    An action that DOES read a non-app-root mount must treat its contents as
//    untrusted input and run under a resource budget (§8.14).
//  - Best-effort isolation: a throwing action never breaks the mount (each call is
//    wrapped); unmount actions run in reverse registration order.
import * as logger from '../utils/logger';

export interface MountContext {
  /** Absolute path the fs is mounted at (e.g. `/app` or `/mnt/{hash}`). */
  path: string;
  /** True for the app's own repo (the bundler's entrypoint root). Host-asserted. */
  isAppRoot: boolean;
  /** Canonical mount id (`scheme:locator`), when known. */
  uri?: string;
  /** Backend kind, when known (e.g. `firestore`). */
  type?: string;
}

export interface MountAction {
  readonly name: string;
  onMount(ctx: MountContext): Promise<void> | void;
  onUnmount?(ctx: MountContext): Promise<void> | void;
}

export class MountLifecycle {
  private actions: MountAction[] = [];

  /** Register a post-mount action. Runtime-only — never call this with app input. */
  register(action: MountAction): void {
    this.actions.push(action);
  }

  /** Run every action's `onMount` for a freshly-mounted fs, best-effort + isolated. */
  async runMount(ctx: MountContext): Promise<void> {
    for (const action of this.actions) {
      try {
        await action.onMount(ctx);
      } catch (err) {
        logger.error(`mount action '${action.name}' failed for ${ctx.path}`, err);
      }
    }
  }

  /** Run every action's `onUnmount` (reverse order) before an fs is unmounted. */
  async runUnmount(ctx: MountContext): Promise<void> {
    for (const action of [...this.actions].reverse()) {
      try {
        await action.onUnmount?.(ctx);
      } catch (err) {
        logger.error(`unmount action '${action.name}' failed for ${ctx.path}`, err);
      }
    }
  }
}
