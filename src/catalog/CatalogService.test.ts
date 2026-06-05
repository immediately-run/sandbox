import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { CatalogService } from './CatalogService';
import { CATALOG_MESSAGE } from './catalogState';

const makeBus = () => {
  const emitter = new Emitter<any>();
  const bus = { onMessage: emitter.event } as unknown as IFrameParentMessageBus;
  return { bus, fire: (msg: any) => emitter.fire(msg) };
};

const catMsg = (methods: Array<{ name: string; capability: string; stream?: boolean }>) => ({
  type: CATALOG_MESSAGE,
  methods,
});

describe('CatalogService', () => {
  it('starts with an empty catalog', () => {
    const { bus } = makeBus();
    expect(new CatalogService(bus).getCatalog()).toEqual([]);
  });

  it('caches the latest catalog from api-catalog messages', () => {
    const { bus, fire } = makeBus();
    const svc = new CatalogService(bus);
    fire(catMsg([{ name: 'spaces:mount', capability: 'spaces:app' }]));
    expect(svc.getCatalog()).toEqual([{ name: 'spaces:mount', capability: 'spaces:app' }]);
  });

  it('drops malformed entries defensively (untrusted parent message)', () => {
    const { bus, fire } = makeBus();
    const svc = new CatalogService(bus);
    fire({
      type: CATALOG_MESSAGE,
      methods: [{ name: 'ok:m', capability: 'c' }, { name: 42 }, null, { capability: 'x' }],
    });
    expect(svc.getCatalog()).toEqual([{ name: 'ok:m', capability: 'c' }]);
  });

  it('ignores unrelated messages', () => {
    const { bus, fire } = makeBus();
    const svc = new CatalogService(bus);
    fire({ type: 'theme', theme: 'dark' });
    expect(svc.getCatalog()).toEqual([]);
  });

  it('replays immediately to new subscribers, then on change; suppresses no-ops', () => {
    const { bus, fire } = makeBus();
    const svc = new CatalogService(bus);
    fire(catMsg([{ name: 'a:m', capability: 'c' }]));

    const seen: string[][] = [];
    svc.onChange((c) => seen.push(c.map((m) => m.name)));
    expect(seen).toEqual([['a:m']]); // immediate replay

    fire(catMsg([{ name: 'a:m', capability: 'c' }])); // identical → no fire
    fire(catMsg([{ name: 'a:m', capability: 'c' }, { name: 'b:m', capability: 'c' }]));
    expect(seen).toEqual([['a:m'], ['a:m', 'b:m']]);
  });
});
