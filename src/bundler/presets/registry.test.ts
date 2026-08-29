// R3-422: preset-registry noise. The host's INIT `template` maps onto the React
// preset (immediately.run is React-only), and the old unconditional
// `logger.warn('Unknown preset …')` fired on every load and buried real errors.
//
// The quiet set is deliberately the sandpack *environment* vocabulary only.
// Verified 2026-08-29 rather than assumed: site-main renders `<SandpackProvider>`
// with no `template` prop and never sets `sandboxSetup.template`, and
// sandpack-client resolves `sandboxSetup.template ?? "parcel"` — so `parcel` is
// the only value a healthy boot produces. Framework names are NOT quiet: on a
// React-only platform one of those asserts a non-React template, which is the
// host/sandbox contract skew the warn exists for.
import { getPreset } from './registry';
import { ReactPreset } from './react/ReactPreset';

describe('getPreset (R3-422 known-alias mapping)', () => {
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('returns the registered React preset for create-react-app without logging', () => {
    const preset = getPreset('create-react-app');
    expect(preset).toBeInstanceOf(ReactPreset);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it.each(['node', 'parcel', 'static'])(
    'maps the known sandpack environment %p to React WITHOUT a console.warn',
    (name) => {
      const preset = getPreset(name);
      expect(preset).toBeInstanceOf(ReactPreset);
      // The happy path must not warn — this was the per-load console noise.
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  // The name that actually arrives. Pinned on its own so a future change to the
  // quiet set cannot silently stop covering the only value a real boot sends.
  it('maps the real-world default `parcel` to React without warning', () => {
    expect(getPreset('parcel')).toBeInstanceOf(ReactPreset);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // The counterweight to the quiet set: silencing these cost the only signal that
  // a non-React template was sent, and they were never part of the recurring
  // noise (only `parcel` arrives), so they must warn.
  it.each(['vue-cli', 'svelte', 'solid', 'angular-cli'])(
    'warns for the framework name %p — a non-React template is contract skew',
    (name) => {
      const preset = getPreset(name);
      expect(preset).toBeInstanceOf(ReactPreset); // fallback behavior unchanged
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('Unknown preset');
    },
  );

  it('still warns loudly for a name outside the known vocabulary', () => {
    const preset = getPreset('definitely-not-a-template');
    expect(preset).toBeInstanceOf(ReactPreset); // fallback behavior unchanged
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('Unknown preset');
  });
});
