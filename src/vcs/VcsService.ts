import { IFrameParentMessageBus } from '../protocol/iframe';
import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import {
  DEFAULT_VCS_STATE,
  VCS_STATE_MESSAGE,
  VcsBranch,
  VcsChange,
  VcsPR,
  VcsState,
  vcsStatesEqual,
} from './vcsState';

/**
 * Caches the source-control state (the diff/branch/PR summary, §5.3) the parent
 * relays over postMessage and exposes it to app code through the bundler, via the
 * SDK's getVcsState / onVcsStateChange / useVcsState. Mirrors ThemeService /
 * EditorContextService / CatalogService.
 *
 *  - `getState()` — a pollable snapshot of the latest known state.
 *  - `onChange(listener)` — fires on every change and, BehaviorSubject-style,
 *    immediately replays the current value to a new listener.
 *
 * Instantiated as early as possible so a `vcs-state` message that arrives before
 * the bundler exists is still captured. The parent only sends this message to
 * iframes holding `vcs:read` (the channel ACL), so an app that never receives one
 * simply sees the default empty state. The message is untrusted — every field is
 * defensively validated before it is cached.
 */
export class VcsService {
  private state: VcsState = DEFAULT_VCS_STATE;
  private changeEmitter = new Emitter<VcsState>();

  constructor(messageBus: IFrameParentMessageBus) {
    messageBus.onMessage((msg: any) => {
      if (msg && msg.type === VCS_STATE_MESSAGE && Array.isArray(msg.changes)) {
        this.setState({
          changes: sanitizeChanges(msg.changes),
          branch: sanitizeBranch(msg.branch),
          prs: sanitizePRs(msg.prs),
          diffLoading: msg.diffLoading === true,
        });
      }
    });
  }

  private setState(next: VcsState): void {
    if (vcsStatesEqual(this.state, next)) {
      return;
    }
    this.state = next;
    this.changeEmitter.fire(next);
  }

  /** Pollable snapshot of the current source-control state. */
  getState(): VcsState {
    return this.state;
  }

  /**
   * Subscribe to source-control changes. The listener is invoked immediately with
   * the current state, then again on every change. Returns a disposable.
   */
  onChange(listener: (state: VcsState) => void): IDisposable {
    const disposable = this.changeEmitter.event(listener);
    listener(this.state);
    return disposable;
  }
}

const CHANGE_STATUSES = new Set(['created', 'modified', 'deleted']);

const sanitizeChanges = (raw: unknown[]): VcsChange[] =>
  raw.filter(
    (c: unknown): c is VcsChange =>
      !!c && typeof (c as VcsChange).path === 'string' && CHANGE_STATUSES.has((c as VcsChange).status)
  );

const sanitizeBranch = (raw: unknown): VcsBranch | null => {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as VcsBranch;
  if (
    typeof b.name !== 'string' ||
    typeof b.parentRepo !== 'string' ||
    typeof b.parentRef !== 'string' ||
    typeof b.parentCommitSha !== 'string'
  ) {
    return null;
  }
  return {
    name: b.name,
    parentRepo: b.parentRepo,
    parentRef: b.parentRef,
    parentCommitSha: b.parentCommitSha,
    upstreamPushable: typeof b.upstreamPushable === 'boolean' ? b.upstreamPushable : null,
  };
};

const sanitizePRs = (raw: unknown): VcsPR[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p: unknown): p is VcsPR =>
      !!p &&
      typeof (p as VcsPR).number === 'number' &&
      typeof (p as VcsPR).url === 'string' &&
      typeof (p as VcsPR).title === 'string' &&
      typeof (p as VcsPR).state === 'string' &&
      typeof (p as VcsPR).draft === 'boolean'
  );
};
