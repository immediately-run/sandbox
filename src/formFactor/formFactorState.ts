/**
 * The form factor of the surface an app is rendered into, mirrored from the
 * parent window into the sandbox (UI_AS_APPS_SPEC §5.4.1).
 *
 * The host owns the region's box (a narrow chrome panel, a full preview, a
 * mobile carousel pane) and relays it as a `form-factor` message. The sandbox
 * caches it (see `FormFactorService`) so app code can render responsively via
 * the SDK's useFormFactor. Baseline capability `formFactor:read` — every app
 * may read it. This is the bridge to MOBILE_SUPPORT_SPEC.
 */
export type FormFactorClass = 'mobile' | 'tablet' | 'desktop';
export type Orientation = 'portrait' | 'landscape';

export interface FormFactor {
  class: FormFactorClass;
  orientation: Orientation;
  width: number;
  height: number;
}

/** Assumed before the parent reports — a reasonable desktop default. */
export const DEFAULT_FORM_FACTOR: FormFactor = {
  class: 'desktop',
  orientation: 'landscape',
  width: 1280,
  height: 800,
};

/** Identity message the parent sends to push the current form factor. */
export const FORM_FACTOR_MESSAGE = 'form-factor';

/** Sent by the sandbox once registered, asking the parent to reply. */
export const REQUEST_FORM_FACTOR_MESSAGE = 'request-form-factor';

export const formFactorsEqual = (a: FormFactor, b: FormFactor): boolean =>
  a.class === b.class &&
  a.orientation === b.orientation &&
  a.width === b.width &&
  a.height === b.height;

export const isFormFactor = (v: any): v is FormFactor =>
  v &&
  (v.class === 'mobile' || v.class === 'tablet' || v.class === 'desktop') &&
  (v.orientation === 'portrait' || v.orientation === 'landscape') &&
  typeof v.width === 'number' &&
  typeof v.height === 'number';
