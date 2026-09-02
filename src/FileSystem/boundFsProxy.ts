/**
 * The proxy shape both app-facing `fs` wrappers are built on.
 *
 * `withReadOnlyMounts` (the EROFS write-guard) and `withRaceTolerance` (the
 * R3-408 retry semantics) each wrap the bound `fs` object handed to app code,
 * one layered outside the other, and each needs the same three decisions
 * before it can differ:
 *
 *  - `fs.promises` is wrapped by its own wrapper and MEMOIZED. The app reads
 *    `fs.promises` repeatedly (and may hold on to it), so the property has to
 *    keep one identity per wrap; re-wrapping per access would hand out fresh,
 *    unequal objects and re-wrap an already-wrapped surface on the outer layer.
 *  - Only string-keyed function properties are candidates for wrapping.
 *    Everything else — symbols, constants, nested objects — passes through as
 *    the target has it, so a wrapper never has to enumerate what it is NOT
 *    guarding.
 *  - A wrapper that needs the promises surface for a method's own work (the
 *    recursive-mkdir stat, say) must see the MEMOIZED proxy when the app has
 *    already touched `.promises`, and the raw surface when it has not —
 *    reaching for it must not itself create the wrapper.
 *
 * The wrappers supply the two `wrap*` callbacks and keep their own policy.
 */

export type FsMethod = (...args: unknown[]) => unknown;

/** Resolve the promises surface for a wrapper's internal use: the memoized proxy
 *  if one exists, else the target's own, without creating one. */
export type PromisesOf = (target: object, receiver: unknown) => Record<string, unknown>;

export function wrapBoundFs<T extends object>(
  boundFs: T,
  wrapPromises: (promises: Record<string, unknown>) => Record<string, unknown>,
  wrapMethod: (prop: string, fn: FsMethod, target: T, receiver: unknown, promisesOf: PromisesOf) => unknown,
): T {
  let promisesProxy: Record<string, unknown> | undefined;
  const promisesOf: PromisesOf = (target, receiver) =>
    promisesProxy ?? (Reflect.get(target, 'promises', receiver) as Record<string, unknown>);

  return new Proxy(boundFs, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'promises' && value && typeof value === 'object') {
        promisesProxy ??= wrapPromises(value as Record<string, unknown>);
        return promisesProxy;
      }
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      return wrapMethod(prop, value as FsMethod, target, receiver, promisesOf);
    },
  });
}
