/**
 * platform/kernel/singleton.ts — Singletons that survive the bundler
 *
 * A `let` at module scope is not one value per process. Next bundles `instrumentation.ts`
 * and each route handler as separate entries, and application modules are duplicated across
 * them, so a module loaded from two entries has two copies of its state — in the same Node
 * runtime, not across Edge and Node.
 *
 * That was not a theory. A module-identity diagnostic showed `platform/observability` loading
 * twice with different ids: `initObservability()` set state on one copy and `/api/health`
 * read the other and found null, moments after startup had logged success.
 *
 * The consequence was not confined to observability. `initProviders()` had the same shape, so
 * every provider the environment selects — the trajectory store, the budget store, the
 * moderation store — was registered on a copy no request ever read, and every route ran the
 * in-memory default instead. Nothing reported it, because each accessor falls back to a
 * working default rather than failing.
 *
 * ## Why `Symbol.for`
 *
 * This module is duplicated by the bundler like any other. A module-local symbol would
 * therefore differ between copies and reproduce the bug inside the fix. A plain string
 * property on `globalThis` would work, but collides with anything else choosing the same
 * name. `Symbol.for()` consults the cross-realm symbol registry: every copy of this file in
 * the isolate resolves the same key, and the namespace prefix keeps it ours.
 *
 * ## What this is not
 *
 * Not a service locator, and not for application state. It exists so that ONE process-wide
 * value stays one value. Anything request-scoped belongs in the request, and anything
 * durable belongs in a store.
 *
 * @module platform/kernel
 */

/**
 * Cross-realm key. Namespaced because the global symbol registry is shared with every
 * library in the process.
 */
const REGISTRY_KEY = Symbol.for("datankare.platform.singletons.v1");

type Registry = Map<string, unknown>;

/**
 * The single Map, created once per isolate however many copies of this module exist.
 */
function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let store = g[REGISTRY_KEY];
  if (!store) {
    store = new Map<string, unknown>();
    g[REGISTRY_KEY] = store;
  }
  return store;
}

/**
 * Read a singleton, creating it from `create` on first access.
 *
 * `create` runs at most once per isolate. Callers keep their existing shape — a module-level
 * `getX()` that returns a default — while the value itself now lives somewhere the bundle
 * split cannot duplicate.
 */
export function getSingleton<T>(key: string, create: () => T): T {
  const store = registry();
  if (!store.has(key)) {
    store.set(key, create());
  }
  return store.get(key) as T;
}

/**
 * Replace a singleton. Returns the previous value, or undefined if unset.
 *
 * Returning the previous value is deliberate: a caller swapping an implementation
 * temporarily — a test, or a consumer overriding a provider for one operation — can restore
 * it without reaching for a reset that also discards anyone else's registration.
 */
export function setSingleton<T>(key: string, value: T): T | undefined {
  const store = registry();
  const previous = store.get(key) as T | undefined;
  store.set(key, value);
  return previous;
}

/** Whether a singleton has been created or set. Distinguishes "unset" from "set to a default". */
export function hasSingleton(key: string): boolean {
  return registry().has(key);
}

/**
 * Forget a singleton, so the next read re-creates it from its factory.
 *
 * Every reset* function in the platform is a test affordance, and this is the primitive
 * beneath them.
 */
export function resetSingleton(key: string): void {
  registry().delete(key);
}

/** Forget every singleton. Test affordance — never call this from application code. */
export function resetAllSingletons(): void {
  registry().clear();
}

/** Registered keys, for diagnostics and the startup self-check. */
export function singletonKeys(): readonly string[] {
  return [...registry().keys()].sort();
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// 1. `Symbol.for`, not a module-local symbol. This module is duplicated by the bundler like
//    every other; a local symbol would differ per copy and rebuild the bug inside the fix.
//
// 2. Keys are namespaced strings ("platform.agents.trajectoryStore"), not bare names. The
//    Map is process-wide and shared with anything else that imports this.
//
// 3. This does not make anything durable. It makes one process see one value. A restart
//    still starts empty — durability is what the Supabase stores are for.
