import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { ThemeService } from './ThemeService';
import { THEME_MESSAGE, HostTheme } from './themeState';

// Minimal stand-in for the message bus: ThemeService only consumes `onMessage`.
const makeBus = () => {
  const emitter = new Emitter<any>();
  const bus = { onMessage: emitter.event } as unknown as IFrameParentMessageBus;
  return { bus, fire: (msg: any) => emitter.fire(msg) };
};

const themeMsg = (theme: HostTheme) => ({ type: THEME_MESSAGE, theme });

describe('ThemeService', () => {
  it('starts at the default theme (dark)', () => {
    const { bus } = makeBus();
    expect(new ThemeService(bus).getTheme()).toBe('dark');
  });

  it('caches the latest theme from theme messages', () => {
    const { bus, fire } = makeBus();
    const theme = new ThemeService(bus);
    fire(themeMsg('light'));
    expect(theme.getTheme()).toBe('light');
    fire(themeMsg('dark'));
    expect(theme.getTheme()).toBe('dark');
  });

  it('ignores unrelated messages and malformed theme values', () => {
    const { bus, fire } = makeBus();
    const theme = new ThemeService(bus);
    fire({ type: 'urlchange', url: '/foo' });
    fire({ type: THEME_MESSAGE, theme: 'rainbow' }); // not light|dark
    expect(theme.getTheme()).toBe('dark');
  });

  it('replays the current theme immediately to new subscribers', () => {
    const { bus, fire } = makeBus();
    const theme = new ThemeService(bus);
    fire(themeMsg('light'));
    const seen: HostTheme[] = [];
    theme.onChange((t) => seen.push(t));
    expect(seen).toEqual(['light']);
  });

  it('fires on change but suppresses no-op updates', () => {
    const { bus, fire } = makeBus();
    const theme = new ThemeService(bus);
    const seen: HostTheme[] = [];
    theme.onChange((t) => seen.push(t)); // initial replay: dark
    fire(themeMsg('light'));
    fire(themeMsg('light')); // no-op
    fire(themeMsg('dark'));
    expect(seen).toEqual(['dark', 'light', 'dark']);
  });

  it('stops notifying after dispose', () => {
    const { bus, fire } = makeBus();
    const theme = new ThemeService(bus);
    const seen: HostTheme[] = [];
    theme.onChange((t) => seen.push(t)).dispose();
    fire(themeMsg('light'));
    expect(seen).toEqual(['dark']); // only the replay
  });
});
