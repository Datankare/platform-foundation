# ADR-032 — Bundle-Safe Singletons

**Status:** Accepted
**Date:** 2026-08-11
**Phase:** Phase 5, Sprint 3a
**Supersedes:** nothing. Corrects an assumption present since the provider registry was written.

---

## Context

Every registry in the platform holds its value in a `let` at module scope:

```ts
let currentStore: TrajectoryStore = new InMemoryTrajectoryStore();
export function setTrajectoryStore(next: TrajectoryStore) {
  currentStore = next;
}
export function getTrajectoryStore(): TrajectoryStore {
  return currentStore;
}
```

That is the ordinary Node singleton, and in Node it is correct: a module is evaluated once
per process, so one binding means one value.

**Next.js does not load modules once per process.** `instrumentation.ts` and each route
handler are separate bundle entries, and application modules are duplicated across them. A
module imported by both is evaluated twice in the same Node runtime, and each copy gets its
own module scope.

This was established by observation, not inference. A diagnostic stamped
`platform/observability` with a per-load id:

```
[diag] observability module loaded { moduleId: 'lfbizkqn' }
[diag] state SET on module         { moduleId: 'lfbizkqn' }
[diag] instrumentation sees        { moduleId: 'lfbizkqn', hasState: true }
[diag] observability module loaded { moduleId: '3l50cepi' }     <- second copy, on first request
[diag] route sees                  { moduleId: '3l50cepi', hasState: false }
```

`initObservability()` set state on one copy; `/api/health` read the other.

### What that cost

21 singleton families across the platform have this shape, and `initProviders()` is one of
them. Every provider the environment selects — `TRAJECTORY_STORE`, `BUDGET_STORE`,
`MODERATION_STORE`, `APP_STATE_STORE`, `CACHE_PROVIDER` — was registered on a copy no request
ever read. Every route ran the in-memory default instead.

So: agent trajectories and budgets not persisted, the daily spend cap resetting every
request, moderation state not accumulating, error reporting and tracing configured and
receiving nothing.

### Why nothing surfaced it

Five mechanisms, each individually reasonable:

1. **Tests do not bundle.** Jest evaluates a module once per file, which is the one
   environment where the pattern works. 2,400 tests exercised it successfully.
2. **The conformance kits test the stores, not the wiring.** `SupabaseTrajectoryStore` is
   thoroughly verified — constructed directly, against a fetch fake. Nothing asserted that the
   registry hands that instance to a route.
3. **Every accessor falls back to a working default.** `getTrajectoryStore()` returns an
   in-memory store rather than throwing; `tryGetObservability()` returns null and callers
   no-op. A completely unwired system is indistinguishable from a working one.
4. **`/api/health` returned a hardcoded `"ok"`.** The one component whose job was to report
   the truth was a literal.
5. **The durable stores were never switched on.** The env vars are unset, so in-memory was
   also the expected behaviour, and no discrepancy existed to notice.

---

## Decision

**Process-wide singletons are anchored on `globalThis` under a well-known symbol, via a
single primitive in `platform/kernel/singleton.ts`.**

```ts
const REGISTRY_KEY = Symbol.for("datankare.platform.singletons.v1");
```

### D1 — `Symbol.for`, not a module-local symbol and not a string property

The primitive is itself duplicated by the bundler. A module-local symbol would differ between
copies and rebuild the bug inside the fix. A plain string property on `globalThis` would work
but collides with any other library choosing the same name. `Symbol.for()` consults the
cross-realm symbol registry, so every copy resolves the same key, and the namespace prefix
keeps the entry ours.

### D2 — Accessors keep their existing shape

`getSingleton(key, create)` creates on first access. Callers keep their `getX()` /
`setX()` / `resetX()` surface, so no consumer changes and no conformance kit is affected. The
value moves; the API does not.

### D3 — `setSingleton` returns the previous value

A caller swapping an implementation temporarily can restore it without a reset that would
also discard someone else's registration. This matches `setProposalStore` and
`setEffectLedger`, and corrects `setBudgetTracker`, which returned void until Sprint 2.

### D4 — This is not durability

The registry makes one process see one value. A restart still starts empty. Persistence is
what the Supabase stores are for, and conflating the two is how a cache becomes a database.

### D5 — A fallback that fires on missing configuration is an error, not a default

Returning an in-memory store when `TRAJECTORY_STORE=supabase` is set is not a graceful
degradation — it is a silent substitution of something the operator did not ask for. Where
configuration selects a provider and the provider is absent at read time, the accessor warns.
This is what makes the class of defect visible rather than merely fixed once.

---

## Consequences

**Good.** Configuration takes effect. One primitive rather than 21 ad-hoc fixes. The
`hasSingleton` distinction between "unset" and "set to a default" makes the startup
self-check possible.

**Costs.** A process-global registry is shared state, and a key collision would be
confusing — mitigated by namespaced keys and a versioned symbol. Test isolation now depends
on `resetAllSingletons()` rather than module re-import, which is more explicit and less
magical, but it is a change in how isolation is achieved.

**Not addressed here.** The durable stores still need switching on (TASK-075), and detecting
silence still needs something outside the process (TASK-076). Neither is code.

---

_Last updated: August 11, 2026 (Phase 5 Sprint 3a — accepted, proven against a live build)_
