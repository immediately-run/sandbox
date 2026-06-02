import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import {
  AUTH_STATE_MESSAGE,
  SandboxAuthState,
  UNKNOWN_AUTH_STATE,
  authStatesEqual,
} from './authState';

/**
 * Caches the auth/account state the parent relays over postMessage and exposes
 * it to the rest of the sandbox (and, through the bundler, to app code via the
 * SDK).
 *
 * Two access patterns are supported, mirroring the SDK surface:
 *  - `getState()` — a pollable snapshot of the latest known state.
 *  - `onChange(listener)` — a subscription that fires on every change and, like
 *    a BehaviorSubject, immediately replays the current state to a new
 *    listener so late subscribers (app code boots well after the iframe
 *    registers) don't miss the value.
 *
 * Instantiated as early as possible (in the `SandpackInstance` constructor) so
 * an `auth-state` message that arrives before the bundler exists is still
 * captured rather than dropped.
 */
export class AuthService {
  private state: SandboxAuthState = UNKNOWN_AUTH_STATE;
  private changeEmitter = new Emitter<SandboxAuthState>();

  constructor(messageBus: IFrameParentMessageBus) {
    messageBus.onMessage((msg: any) => {
      if (msg && msg.type === AUTH_STATE_MESSAGE && msg.state) {
        this.setState(msg.state as SandboxAuthState);
      }
    });
  }

  private setState(next: SandboxAuthState): void {
    if (authStatesEqual(this.state, next)) {
      return;
    }
    this.state = next;
    this.changeEmitter.fire(next);
  }

  /** Pollable snapshot of the current auth state. */
  getState(): SandboxAuthState {
    return this.state;
  }

  /**
   * Subscribe to auth-state changes. The listener is invoked immediately with
   * the current state, then again on every subsequent change. Returns a
   * disposable that removes the listener.
   */
  onChange(listener: (state: SandboxAuthState) => void): IDisposable {
    const disposable = this.changeEmitter.event(listener);
    listener(this.state);
    return disposable;
  }
}
