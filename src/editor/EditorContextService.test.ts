import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { EditorContextService } from './EditorContextService';
import { EDITOR_CONTEXT_MESSAGE } from './editorContextState';

// Minimal stand-in for the message bus: the service only consumes `onMessage`.
const makeBus = () => {
  const emitter = new Emitter<any>();
  const bus = { onMessage: emitter.event } as unknown as IFrameParentMessageBus;
  return { bus, fire: (msg: any) => emitter.fire(msg) };
};

const ctxMsg = (dirtyPaths: string[]) => ({ type: EDITOR_CONTEXT_MESSAGE, dirtyPaths });

describe('EditorContextService', () => {
  it('starts with an empty dirty set', () => {
    const { bus } = makeBus();
    expect(new EditorContextService(bus).getContext()).toEqual({ dirtyPaths: [] });
  });

  it('caches the latest dirty set from editor-context messages', () => {
    const { bus, fire } = makeBus();
    const svc = new EditorContextService(bus);
    fire(ctxMsg(['a.ts', 'b.ts']));
    expect(svc.getContext()).toEqual({ dirtyPaths: ['a.ts', 'b.ts'] });
    fire(ctxMsg([]));
    expect(svc.getContext()).toEqual({ dirtyPaths: [] });
  });

  it('drops non-string entries defensively (untrusted parent message)', () => {
    const { bus, fire } = makeBus();
    const svc = new EditorContextService(bus);
    fire({ type: EDITOR_CONTEXT_MESSAGE, dirtyPaths: ['ok.ts', 42, null, 'two.ts'] });
    expect(svc.getContext()).toEqual({ dirtyPaths: ['ok.ts', 'two.ts'] });
  });

  it('ignores unrelated messages', () => {
    const { bus, fire } = makeBus();
    const svc = new EditorContextService(bus);
    fire({ type: 'theme', theme: 'dark' });
    expect(svc.getContext()).toEqual({ dirtyPaths: [] });
  });

  it('replays the current value immediately to new subscribers, then on change', () => {
    const { bus, fire } = makeBus();
    const svc = new EditorContextService(bus);
    fire(ctxMsg(['x.ts']));

    const seen: string[][] = [];
    svc.onChange((c) => seen.push(c.dirtyPaths));
    expect(seen).toEqual([['x.ts']]); // immediate replay

    fire(ctxMsg(['x.ts', 'y.ts']));
    expect(seen).toEqual([['x.ts'], ['x.ts', 'y.ts']]);
  });

  it('suppresses no-op change events (equal dirty sets)', () => {
    const { bus, fire } = makeBus();
    const svc = new EditorContextService(bus);
    const seen: string[][] = [];
    svc.onChange((c) => seen.push(c.dirtyPaths));
    fire(ctxMsg(['a.ts']));
    fire(ctxMsg(['a.ts'])); // identical → no second fire
    expect(seen).toEqual([[], ['a.ts']]);
  });
});
