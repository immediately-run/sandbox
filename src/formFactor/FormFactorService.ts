import { IDisposable } from '../utils/Disposable';
import { Emitter } from '../utils/emitter';
import { IFrameParentMessageBus } from '../protocol/iframe';
import {
  FormFactor,
  DEFAULT_FORM_FACTOR,
  FORM_FACTOR_MESSAGE,
  formFactorsEqual,
  isFormFactor,
} from './formFactorState';

/**
 * Caches the form factor the parent relays over postMessage and exposes it to
 * app code (via the SDK's getFormFactor / onFormFactorChange / useFormFactor).
 * Mirrors `ThemeService` / `AuthService`. Constructed early so a `form-factor`
 * message arriving before the bundler exists is captured rather than dropped.
 */
export class FormFactorService {
  private formFactor: FormFactor = DEFAULT_FORM_FACTOR;
  private changeEmitter = new Emitter<FormFactor>();

  constructor(messageBus: IFrameParentMessageBus) {
    messageBus.onMessage((msg: any) => {
      if (msg && msg.type === FORM_FACTOR_MESSAGE && isFormFactor(msg.formFactor)) {
        this.set(msg.formFactor as FormFactor);
      }
    });
  }

  private set(next: FormFactor): void {
    if (formFactorsEqual(this.formFactor, next)) {
      return;
    }
    this.formFactor = next;
    this.changeEmitter.fire(next);
  }

  /** Pollable snapshot of the current form factor. */
  getFormFactor(): FormFactor {
    return this.formFactor;
  }

  /**
   * Subscribe to form-factor changes. The listener is invoked immediately with
   * the current value, then again on every change. Returns a disposable.
   */
  onChange(listener: (formFactor: FormFactor) => void): IDisposable {
    const disposable = this.changeEmitter.event(listener);
    listener(this.formFactor);
    return disposable;
  }
}
