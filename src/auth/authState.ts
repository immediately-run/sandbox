/**
 * Auth/account state mirrored from the parent window into the sandbox.
 *
 * The parent (immediately.run host) owns the real session (Firebase user +
 * GitHub login) and relays it over the parent→iframe postMessage channel as an
 * `auth-state` message. The sandbox caches the latest value (see `AuthService`)
 * so app code can poll it or subscribe to changes via the SDK.
 */
export type AuthStatus = 'unknown' | 'signed-in' | 'signed-out';

/** The signed-in user, as exposed to sandboxed app code. */
export interface SandboxUser {
  /** GitHub login (handle) of the signed-in user. */
  login: string;
}

export interface SandboxAuthState {
  status: AuthStatus;
  user: SandboxUser | null;
}

/**
 * State before the parent has reported anything. `status: 'unknown'` lets app
 * code distinguish "not yet known" from a confirmed signed-out session.
 */
export const UNKNOWN_AUTH_STATE: SandboxAuthState = { status: 'unknown', user: null };

/** Identity message the parent sends to push the current auth state. */
export const AUTH_STATE_MESSAGE = 'auth-state';

/** Sent by the sandbox once registered, asking the parent to reply with state. */
export const REQUEST_AUTH_STATE_MESSAGE = 'request-auth-state';

/** True when two states are equivalent (used to suppress no-op change events). */
export const authStatesEqual = (a: SandboxAuthState, b: SandboxAuthState): boolean =>
  a.status === b.status && (a.user?.login ?? null) === (b.user?.login ?? null);
