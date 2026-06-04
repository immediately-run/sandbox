import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import {
  HostTheme,
  DEFAULT_THEME,
  THEME_MESSAGE,
  themesEqual,
} from './themeState';

/**
 * Caches the host UI theme the parent relays over postMessage and exposes it to
 * app code (through the bundler, via the SDK's getHostTheme / onHostThemeChange
 * / useHostTheme). Mirrors `AuthService`.
 *
 * Two access patterns, mirroring the SDK surface:
 *  - `getTheme()` — a pollable snapshot of the latest known theme.
 *  - `onChange(listener)` — fires on every change and, BehaviorSubject-style,
 *    immediately replays the current value to a new listener so late
 *    subscribers (app code boots after the iframe registers) don't miss it.
 *
 * Instantiated as early as possible (in the `SandpackInstance` constructor) so a
 * `theme` message that arrives before the bundler exists is still captured.
 */
export class ThemeService {
  private theme: HostTheme = DEFAULT_THEME;
  private changeEmitter = new Emitter<HostTheme>();

  constructor(messageBus: IFrameParentMessageBus) {
    messageBus.onMessage((msg: any) => {
      if (
        msg &&
        msg.type === THEME_MESSAGE &&
        (msg.theme === 'light' || msg.theme === 'dark')
      ) {
        this.setTheme(msg.theme as HostTheme);
      }
    });
  }

  private setTheme(next: HostTheme): void {
    if (themesEqual(this.theme, next)) {
      return;
    }
    this.theme = next;
    this.changeEmitter.fire(next);
  }

  /** Pollable snapshot of the current host theme. */
  getTheme(): HostTheme {
    return this.theme;
  }

  /**
   * Subscribe to theme changes. The listener is invoked immediately with the
   * current theme, then again on every change. Returns a disposable.
   */
  onChange(listener: (theme: HostTheme) => void): IDisposable {
    const disposable = this.changeEmitter.event(listener);
    listener(this.theme);
    return disposable;
  }
}
