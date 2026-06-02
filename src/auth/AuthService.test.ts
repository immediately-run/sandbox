import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { AuthService } from './AuthService';
import { AUTH_STATE_MESSAGE, SandboxAuthState } from './authState';

// Minimal stand-in for the message bus: AuthService only consumes `onMessage`.
const makeBus = () => {
  const emitter = new Emitter<any>();
  const bus = { onMessage: emitter.event } as unknown as IFrameParentMessageBus;
  return { bus, fire: (msg: any) => emitter.fire(msg) };
};

const authMsg = (state: SandboxAuthState) => ({ type: AUTH_STATE_MESSAGE, state });

describe('AuthService', () => {
  it('starts in the unknown state', () => {
    const { bus } = makeBus();
    const auth = new AuthService(bus);
    expect(auth.getState()).toEqual({ status: 'unknown', user: null });
  });

  it('caches the latest state from auth-state messages', () => {
    const { bus, fire } = makeBus();
    const auth = new AuthService(bus);

    fire(authMsg({ status: 'signed-in', user: { login: 'octocat' } }));
    expect(auth.getState()).toEqual({ status: 'signed-in', user: { login: 'octocat' } });

    fire(authMsg({ status: 'signed-out', user: null }));
    expect(auth.getState()).toEqual({ status: 'signed-out', user: null });
  });

  it('ignores unrelated messages', () => {
    const { bus, fire } = makeBus();
    const auth = new AuthService(bus);
    fire({ type: 'urlchange', url: '/foo' });
    expect(auth.getState()).toEqual({ status: 'unknown', user: null });
  });

  it('replays the current state immediately to new subscribers', () => {
    const { bus, fire } = makeBus();
    const auth = new AuthService(bus);
    fire(authMsg({ status: 'signed-in', user: { login: 'octocat' } }));

    const seen: SandboxAuthState[] = [];
    auth.onChange((s) => seen.push(s));
    expect(seen).toEqual([{ status: 'signed-in', user: { login: 'octocat' } }]);
  });

  it('fires subscribers on change but suppresses no-op updates', () => {
    const { bus, fire } = makeBus();
    const auth = new AuthService(bus);

    const seen: SandboxAuthState[] = [];
    auth.onChange((s) => seen.push(s)); // initial replay: unknown

    fire(authMsg({ status: 'signed-in', user: { login: 'octocat' } }));
    fire(authMsg({ status: 'signed-in', user: { login: 'octocat' } })); // no-op
    fire(authMsg({ status: 'signed-out', user: null }));

    expect(seen).toEqual([
      { status: 'unknown', user: null },
      { status: 'signed-in', user: { login: 'octocat' } },
      { status: 'signed-out', user: null },
    ]);
  });

  it('stops notifying after dispose', () => {
    const { bus, fire } = makeBus();
    const auth = new AuthService(bus);

    const seen: SandboxAuthState[] = [];
    const disposable = auth.onChange((s) => seen.push(s));
    disposable.dispose();

    fire(authMsg({ status: 'signed-in', user: { login: 'octocat' } }));
    expect(seen).toEqual([{ status: 'unknown', user: null }]); // only the replay
  });
});
