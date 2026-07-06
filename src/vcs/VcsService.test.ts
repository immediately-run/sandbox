import { IFrameParentMessageBus } from '../protocol/iframe';
import { Emitter } from '../utils/emitter';
import { VcsService } from './VcsService';
import { VCS_STATE_MESSAGE, VcsBranch, VcsPR, VcsState } from './vcsState';

// Minimal stand-in for the message bus: the service only consumes `onMessage`.
const makeBus = () => {
  const emitter = new Emitter<any>();
  const bus = { onMessage: emitter.event } as unknown as IFrameParentMessageBus;
  return { bus, fire: (msg: any) => emitter.fire(msg) };
};

const branch: VcsBranch = {
  name: 'my-edit',
  parentRepo: 'immediately-run/contribute-test',
  parentRef: 'main',
  parentCommitSha: 'abc123',
  upstreamPushable: true,
};
const pr: VcsPR = { number: 7, url: 'https://x/pr/7', title: 'Fix', state: 'open', draft: false };

const stateMsg = (over: Partial<VcsState> = {}) => ({
  type: VCS_STATE_MESSAGE,
  changes: [{ path: '/src/App.tsx', status: 'modified' }],
  branch,
  prs: [pr],
  diffLoading: false,
  ...over,
});

describe('VcsService', () => {
  it('starts with the default empty state', () => {
    const { bus } = makeBus();
    expect(new VcsService(bus).getState()).toEqual({
      changes: [],
      branch: null,
      prs: [],
      diffLoading: false,
    });
  });

  it('caches the latest source-control state from vcs-state messages', () => {
    const { bus, fire } = makeBus();
    const svc = new VcsService(bus);
    fire(stateMsg());
    expect(svc.getState().changes).toEqual([{ path: '/src/App.tsx', status: 'modified' }]);
    expect(svc.getState().branch).toEqual(branch);
    expect(svc.getState().prs).toEqual([pr]);
  });

  it('reads an absent branch/prs as null/[] (defensive)', () => {
    const { bus, fire } = makeBus();
    const svc = new VcsService(bus);
    fire({ type: VCS_STATE_MESSAGE, changes: [], diffLoading: true });
    expect(svc.getState()).toEqual({ changes: [], branch: null, prs: [], diffLoading: true });
  });

  it('drops malformed changes/prs and a malformed branch (untrusted parent)', () => {
    const { bus, fire } = makeBus();
    const svc = new VcsService(bus);
    fire(
      stateMsg({
        changes: [
          { path: 'ok.ts', status: 'created' },
          { path: 42, status: 'created' } as any, // bad path
          { path: 'x.ts', status: 'weird' } as any, // bad status
        ],
        branch: { name: 'b' } as any, // missing fields
        prs: [pr, { number: 'nope' } as any],
      })
    );
    expect(svc.getState().changes).toEqual([{ path: 'ok.ts', status: 'created' }]);
    expect(svc.getState().branch).toBeNull();
    expect(svc.getState().prs).toEqual([pr]);
  });

  it('coerces a non-boolean upstreamPushable to null', () => {
    const { bus, fire } = makeBus();
    const svc = new VcsService(bus);
    fire(stateMsg({ branch: { ...branch, upstreamPushable: 'yes' as any } }));
    expect(svc.getState().branch?.upstreamPushable).toBeNull();
  });

  it('ignores unrelated messages', () => {
    const { bus, fire } = makeBus();
    const svc = new VcsService(bus);
    fire({ type: 'theme', theme: 'dark' });
    expect(svc.getState()).toEqual({ changes: [], branch: null, prs: [], diffLoading: false });
  });

  it('replays the current value immediately to new subscribers, then on change', () => {
    const { bus, fire } = makeBus();
    const svc = new VcsService(bus);
    fire(stateMsg());

    const seen: number[] = [];
    svc.onChange((s) => seen.push(s.changes.length));
    expect(seen).toEqual([1]); // immediate replay

    fire(stateMsg({ changes: [] }));
    expect(seen).toEqual([1, 0]);
  });

  it('suppresses no-op change events (equal states)', () => {
    const { bus, fire } = makeBus();
    const svc = new VcsService(bus);
    const seen: number[] = [];
    svc.onChange((s) => seen.push(s.changes.length));
    fire(stateMsg());
    fire(stateMsg()); // identical → no second fire
    expect(seen).toEqual([0, 1]);
  });
});
