# ADR-028: Application Framework Architecture

**Status:** Accepted
**Date:** 2026-07-22
**Decision Makers:** Raman Sud
**Sprint:** Phase 5 Sprint 1

## Context

Phase 5 builds the application framework: the generic runtime that games, lessons, music
exercises, and SaaS workflows all run on. Prior phases delivered the pieces it composes — the
agent runtime (ADR-022: `AgentIdentity`, `Trajectory`, `Step`, `BudgetConfig`), the RAG and
memory layer (ADR-023), realtime messaging (ADR-018), and the provider/conformance-kit model
(ADR-027). Sprint 1 needs the runtime object, its state model, and its action pipeline — built as
generic abstractions in platform-foundation, with Playform layering domain specifics on top.

The framework must be consumer-agnostic without being so generic it provides no scaffolding, must
make GenAI principles structural rather than conventional (P2, P4, P12, P15, P17, P18), and must
not require re-engineering when later phases (agentic workflows ADR-029, AUX ADR-030) build on it.

## Decision

### D1 — `ActivitySession` is the runtime center; domains are first-class data definitions

The runtime center is a generic `ActivitySession`, not `Game`. Domain concepts are preserved as
first-class **data definitions** — `ActivityDefinition<TState, TAction, TConfig>`, generically
parameterized so `GameDefinition = ActivityDefinition<GameState, GameMove, GameConfig>` is
type-checked, not `unknown`. Definitions are **data + hooks, not classes** (`initialState`,
`validateAction`, `applyAction`, `onComplete`); the framework owns the loop and calls consumer
functions. No framework/consumer inheritance.

**Boundary rule:** the framework owns _mechanism_ (transitions, versioning, persistence,
trajectory, events, lifecycle); the definition owns _policy_ (valid action, state meaning,
completion). Sprint 1 ships the contract + one real domain definition; `Game`/`Workflow` ship as
documented examples until a consumer exists (L11).

### D2 — Application state store is registry slot #14 (narrow, authoritative)

`ActivityStateStore<TState>` is a provider (registry slot `appStateStore: "supabase" | "memory"`)
persisting **versioned state only** — authoritative. Trajectory persistence is reused from
`platform/agents` (not duplicated), written idempotently. A coordinator (SessionService) owns the
two-store sequence: validate → commit state (authoritative) → append trajectory step (idempotent,
eventually consistent). Consumers never touch two stores. Trajectory is reconstructible from state
history, so a lost trajectory write is a recoverable gap, not corruption. No joint-atomic reads
(state may lead trajectory briefly; it converges).

Slot + interface + memory impl + Supabase impl + conformance kit + manifest entry + migration 018
land atomically (L21). See the State Provider Authoring Checklist below.

### D3 — Action pipeline: effects-as-capability, risk floors, tiered durability (P17 + P4)

The framework does not trust consumer declarations for security/audit-relevant properties; it
enforces structurally and takes `max(declared, enforced)`. Three tiers: **ephemeral** (no context,
no audit — a restricted capability environment that structurally cannot touch durable state);
**direct durable** (full `ActionContext`, idempotent, audited, single-phase); **two-phase
propose→commit** (only when `effectiveRisk >= gating threshold`).

Actions declare **effects** (the unit of both capability and risk floor):
`effectiveRisk = max(declaredRisk, max(effectFloors))`. A consumer may raise risk, never lower it
below the effect floor. Seed floors: `stateWrite` ordinary, `externalCall`/`sendMessage`
consequential, `restricted` catch-all. **Invariant:** mutating versioned state requires the
`stateWrite` effect, unreachable from an ephemeral context — durability is structural, not declared.

`ActionContext` (actor, delegation lineage, `operationId`, session, boundary, `effectiveRisk`,
effects) is assembled by the coordinator; the consumer supplies intent + actor + payload only. One
pipeline for human/agent/service/system actors. `operationId` (minted at intent) is the stable
action identity across propose→approve→commit→effect→trajectory; `proposalId` is scoped under it,
present only for revisable gated actions. Full protocol: ADR-031.

### D4 — Every committed mutation appends to the trajectory

One logical operation may append one or more Steps (1:many), keyed by `operationId`. Ephemeral
actions have no trajectory by design (safe: they can't touch durable state). Append is
coordinator-owned, idempotent, reconstructible from state. Session history _is_ the trajectory
(P18); no separate event log.

### D5 — Optimistic concurrency, enforced by store contract

State carries a `version`; a commit against a stale version is **rejected** (never auto-retried —
the domain's `validateAction` must re-run against current state). The rejection returns
`currentVersion` + `currentState` for cheap revalidation. Atomicity is a **store contract** the
conformance kit verifies by racing concurrent commits — provider-independent, not
database-dependent. Two required atomic ops: conditional-commit (CAS on `expectedVersion`) and
reduce-commit (atomic RMW for declared commutative-reducer actions, which resolve hotspots without
a rejection storm). Pessimistic locking is out of scope, with a falsifiable revisit trigger.

### D6 — Capabilities, not modes

Sessions declare `capabilities: ["turn-based" | "real-time" | "persistent" | "multi-agent"]`,
orthogonal and composable; each attaches its own machinery. **Turn-based** ships as a universal
core (turn order, current-turn state, `advanceTurn()`, turn validation, lifecycle events) with
variant machinery (timing, simultaneity, cross-capability interaction) deferred behind
runtime-guarded extension seams: declaring an unimplemented variant **throws at registration** with
a pointer. The variant machinery is not scheduled — it ships on a real turn-based consumer.

### D7 — AUX-shaped returns from day one

Every mutation returns `{ result, trajectory, nextActions, cost }` so ADR-030 (AUX) wraps rather
than rebuilds. `nextActions` is a synchronous filter over the declared action schema (no LLM call);
`cost` is attribution (P12). Computed eagerly by default with an opt-out flag
(`{ computeNextActions: false }`) for high-frequency real-time paths.

### D8 — Session events: framework-native event + subscribers

The core emits a framework-native `SessionEvent`; consumers attach as subscribers. The real-time
capability is one optional subscriber that maps to `RealtimeMessage` (ADR-018). The core has no
hard dependency on `platform/realtime`. `SessionEvent` carries the agentic-native fields natively
(`operationId`, `trajectoryId`, `stepIndex`, intent, memoryHint), so the realtime subscriber
**re-envelopes** rather than translates — no adapter drift.

### D9 — Applications registered, not coded

Ratifies D1. Hooks are **pure functions**; side effects route through the D3 declared-effect
channel (audited, risk-floored), not arbitrary I/O inside hooks — required for replay (D4), the
effects invariant (D3), and AUX inspectability (D7). The `ActivityDefinition` contract is
**additive-only** (new fields optional with defaults; none removed/renamed); real `schemaVersion`
support ships on a trigger (first breaking change or first external consumer).

### D10 — Sessions budget-bounded; most-restrictive-wins

`BudgetConfig` (reused from `platform/agents`) is an optional session field; absent = unbounded
(correct for human-only sessions). Enforcement engages only on cost-incurring actions. When session,
per-trajectory, and per-day budgets disagree, the **minimum applicable ceiling binds** — a session
can tighten but never loosen agent safety caps. Rejections name which ceiling bound. Symmetric with
D3: D3 does `max()` on risk, D10 does `min()` on budget — strictest applicable bound always wins.

## State Provider Authoring Checklist

Adding a new `ActivityStateStore` (e.g. Redis, DynamoDB):

1. Implement `load` / `commit` (atomic CAS) / `reduceCommit` (atomic RMW) / `create` / `delete`.
2. Persist `TState` opaquely (JSON-serializable); keep `version` monotonic.
3. Provide the atomicity primitive — native atomic conditional write (Postgres `UPDATE ... WHERE
version=N`; Redis `WATCH/MULTI/EXEC` or Lua; DynamoDB `ConditionExpression`; in-memory
   check-and-set). No atomic conditional write ⇒ not a valid store.
4. Register the slot in `platform/providers/registry.ts` (`ProviderSelections`, init fn,
   `initProviders()`, env var, memory fallback + warn).
5. Add the conformance kit arm — MUST include concurrency tests (concurrent CAS: exactly one wins;
   reduce-commit associativity; conflict-result shape). CI fails if the slot has no kit.
6. Add the migration (persistent stores) — state table with the action that produced each version
   (reconstructible-state guarantee).
7. Test failure modes (missing config → fallback + warn; unreachable → surfaced error; conflict →
   well-formed result, not exception).
8. Wire `delete` to GDPR hard-purge.
9. Update ADR-028 providers table + README + this checklist.
10. Run the full kit + a manual concurrent-commit smoke for persistent stores.

## Consequences

**Positive:** consumer-agnostic runtime with typed domain definitions; GenAI principles structural
(P2/P4/P12/P15/P17/P18) not conventional; ADR-029/030 wrap rather than refactor; provider-independent
concurrency; forget-proof deferrals (runtime guards, not memory).

**Negative / accepted:** generic parameters propagate through every module; a new state provider is
real engineering (atomic CAS+RMW + kit), not a config line; the mechanism/policy and core/variant
boundaries are load-bearing and must be enforced in review or they erode.

**Deferred (with triggers, not schedules):** turn-based variant machinery (real consumer);
`schemaVersion` (first breaking change / external consumer); pessimistic locking (workload proves
optimistic+commutative insufficient).

## Related

ADR-022 (agent runtime), ADR-023 (RAG/memory), ADR-018 (realtime), ADR-027 (conformance kits),
ADR-029 (agentic workflow framework, forthcoming), ADR-030 (AUX, forthcoming),
ADR-031 (action identity & lifecycle protocol).
