/**
 * @jest-environment jsdom
 *
 * register-frame handshake parsing — the §5.2 dirty set rides IInitConfig
 * alongside sdkIntegrity (PRETRANSPILED_ARTIFACTS_SPEC §5.2).
 */
import { IFrameParentMessageBus } from './iframe';

const registerFrame = (extra: Record<string, unknown>) =>
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'register-frame', id: 'frame-1', template: 'react', ...extra },
    }),
  );

describe('IFrameParentMessageBus register-frame', () => {
  it('reads dirtyPaths into the init config', async () => {
    const bus = new IFrameParentMessageBus();
    registerFrame({ dirtyPaths: ['/src/App.tsx', '/src/old.ts'] });
    const config = await bus.getInitConfig();
    expect(config.dirtyPaths).toEqual(['/src/App.tsx', '/src/old.ts']);
    expect(config.template).toBe('react');
  });

  it('leaves dirtyPaths undefined when the host omits it', async () => {
    const bus = new IFrameParentMessageBus();
    registerFrame({});
    const config = await bus.getInitConfig();
    expect(config.dirtyPaths).toBeUndefined();
  });
});
