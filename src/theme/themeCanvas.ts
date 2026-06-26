import { IDisposable } from '../utils/Disposable';
import { HostTheme } from './themeState';
import { ThemeService } from './ThemeService';

// Brand canvas colours — match the host shell (site-main `public/index.html` boot
// splash / tokens) so the iframe and the host read as one continuous surface.
const CANVAS: Record<HostTheme, string> = {
  dark: '#0b0c0f',
  light: '#fbfbfc',
};

/**
 * Paint the iframe document's base canvas to match the host theme.
 *
 * The sandbox iframe's `<body>` has no background, so before the app's React tree
 * paints — and during any in-app `Suspense` gap (e.g. the SDK's content loaders) —
 * the UA's default **white** canvas shows through. Against the host's dark skeleton
 * that reads as a jarring white flash between the skeleton and the app
 * (LOADING_UX_SPEC §7 / I3). Mirror the host theme onto `<html>` (background +
 * `color-scheme`) so the gap is the right brand canvas, not white.
 *
 * `ThemeService.onChange` replays the current value immediately (dark by default,
 * `DEFAULT_THEME`) and fires again when the parent reports the real theme — so the
 * canvas is **theme-aware**: dark in dark mode, light in light mode, and it follows
 * a live host theme switch. The app still owns its own painted surface; this only
 * fills the pre-paint / between-route gaps behind it.
 */
export function applyThemeCanvas(themeService: ThemeService): IDisposable {
  if (typeof document === 'undefined') return { dispose() {} };
  return themeService.onChange((theme: HostTheme) => {
    const el = document.documentElement;
    el.style.backgroundColor = CANVAS[theme];
    el.style.colorScheme = theme;
  });
}
