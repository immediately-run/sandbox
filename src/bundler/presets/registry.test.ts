// R3-422: preset-registry noise. The host's INIT `template` carries the sandpack
// *environment* vocabulary ('node', 'parcel', 'static', …) which sandpack-client
// derives from the app's package.json — those names arrive on perfectly healthy
// boots and map onto the React preset by design (immediately.run is React-only).
// The old unconditional `logger.warn('Unknown preset node, …')` fired on every
// local-dev load and buried real errors; the warn is now reserved for names
// outside the known vocabulary (a real host/sandbox contract skew).
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

  it('still warns loudly for a name outside the known vocabulary', () => {
    const preset = getPreset('definitely-not-a-template');
    expect(preset).toBeInstanceOf(ReactPreset); // fallback behavior unchanged
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('Unknown preset');
  });
});
