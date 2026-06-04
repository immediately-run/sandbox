import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import { FormFactorService } from './FormFactorService';
import {
  FORM_FACTOR_MESSAGE,
  FormFactor,
  DEFAULT_FORM_FACTOR,
} from './formFactorState';

const makeBus = () => {
  const emitter = new Emitter<any>();
  const bus = { onMessage: emitter.event } as unknown as IFrameParentMessageBus;
  return { bus, fire: (msg: any) => emitter.fire(msg) };
};

const ff = (
  cls: FormFactor['class'],
  orientation: FormFactor['orientation'],
  width: number,
  height: number,
): FormFactor => ({ class: cls, orientation, width, height });

const msg = (formFactor: FormFactor) => ({ type: FORM_FACTOR_MESSAGE, formFactor });

describe('FormFactorService', () => {
  it('starts at the default form factor', () => {
    const { bus } = makeBus();
    expect(new FormFactorService(bus).getFormFactor()).toEqual(DEFAULT_FORM_FACTOR);
  });

  it('caches the latest form factor from messages', () => {
    const { bus, fire } = makeBus();
    const svc = new FormFactorService(bus);
    fire(msg(ff('mobile', 'portrait', 390, 844)));
    expect(svc.getFormFactor()).toEqual(ff('mobile', 'portrait', 390, 844));
  });

  it('ignores unrelated and malformed messages', () => {
    const { bus, fire } = makeBus();
    const svc = new FormFactorService(bus);
    fire({ type: 'urlchange', url: '/x' });
    fire({ type: FORM_FACTOR_MESSAGE, formFactor: { class: 'phone' } }); // invalid
    expect(svc.getFormFactor()).toEqual(DEFAULT_FORM_FACTOR);
  });

  it('replays immediately and fires on change, suppressing no-ops', () => {
    const { bus, fire } = makeBus();
    const svc = new FormFactorService(bus);
    const seen: FormFactor[] = [];
    svc.onChange((f) => seen.push(f)); // replay: default (desktop)
    fire(msg(ff('mobile', 'portrait', 390, 844)));
    fire(msg(ff('mobile', 'portrait', 390, 844))); // no-op
    fire(msg(ff('mobile', 'landscape', 844, 390)));
    expect(seen).toEqual([
      DEFAULT_FORM_FACTOR,
      ff('mobile', 'portrait', 390, 844),
      ff('mobile', 'landscape', 844, 390),
    ]);
  });
});
