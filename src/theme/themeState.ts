/**
 * Host UI theme mirrored from the parent window into the sandbox.
 *
 * The parent (immediately.run host) owns the real theme (its next-themes state)
 * and relays it over the parent→iframe postMessage channel as a `theme` message.
 * The sandbox caches the latest value (see `ThemeService`) so app code can poll
 * it or subscribe via the SDK and render to match the host chrome.
 *
 * Baseline capability `theme:read` (UI_AS_APPS_SPEC §5.4 / §8.2): every app may
 * read the host theme. Writing it (`theme:set`) is a separate, elevated action.
 */
export type HostTheme = 'light' | 'dark';

/**
 * Theme assumed before the parent has reported. Dark is the platform default
 * (design system), so this minimizes the flash for the common case; the
 * `request-theme` poll on registration fetches the real value promptly.
 */
export const DEFAULT_THEME: HostTheme = 'dark';

/** Identity message the parent sends to push the current host theme. */
export const THEME_MESSAGE = 'theme';

/** Sent by the sandbox once registered, asking the parent to reply with theme. */
export const REQUEST_THEME_MESSAGE = 'request-theme';

/** True when two themes are equal (used to suppress no-op change events). */
export const themesEqual = (a: HostTheme, b: HostTheme): boolean => a === b;

/** A theme push message from the parent. */
export interface ThemeMessage {
  type: typeof THEME_MESSAGE;
  theme: HostTheme;
}
