/**
 * __tests__/helpers/interleave.ts — force an interleaving of concurrent calls (TASK-175)
 *
 * A race test that relies on timing passes or fails by luck. These pin the order instead: a
 * `signal` is a one-shot barrier one call opens and another waits on, and `hooked` gives one
 * caller its own view of a store with some methods replaced (each replacement calls through to
 * the store itself), so two concurrent calls can be stopped at different points.
 */

/** A one-shot barrier: `wait` resolves once `open` has been called. */
export interface Signal {
  readonly wait: Promise<void>;
  open(): void;
}

export function signal(): Signal {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/**
 * `target`, with the methods in `overrides` replaced for this view only. Every other member is
 * the target's own (its methods bound to it), so the view writes to the same store.
 */
export function hooked<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        return (overrides as Record<PropertyKey, unknown>)[key];
      }
      const value: unknown = Reflect.get(t, key, t);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(t)
        : value;
    },
  });
}
