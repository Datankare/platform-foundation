# platform/app-framework — Application Framework

The generic runtime that games, lessons, music exercises, and SaaS workflows all run on
(ADR-028). Built as a domain-agnostic abstraction in platform-foundation; consumers layer
domain specifics on top.

## Status

✅ **Sprint 1 (Phase 5)** — runtime object, state store, action pipeline, session coordinator,
turn-based core. Agentic workflow integration (ADR-029) and AUX endpoints (ADR-030) build on
this in later sprints.

## Architecture

The runtime center is a generic `ActivitySession`. Domains are **data definitions** —
`ActivityDefinition<TState, TAction, TConfig>` — not classes. The framework owns _mechanism_;
the definition owns _policy_.

```
ActivityDefinition<TState, TAction, TConfig>     ← domain: data + pure hooks
    ├── GameDefinition, LessonDefinition, ...       (instantiations, type-checked)

ActivitySession<TState, TAction>                 ← generic runtime object
    ├── versioned state    ─────→ ActivityStateStore (slot #14, authoritative)
    ├── trajectory         ─────→ platform/agents (reused, idempotent)
    ├── participants       ─────→ AgentIdentity
    ├── capabilities       ─────→ turn-based | real-time | persistent | multi-agent
    └── events             ─────→ SessionEvent → subscribers (trajectory, audit, realtime)
```

**Mechanism vs policy (the load-bearing boundary):**

- **Framework owns mechanism** — state transitions, versioning, persistence, trajectory/audit,
  event propagation, lifecycle, risk/budget enforcement.
- **Definition owns policy** — what a valid action is (`validateAction`), what a state means,
  how it changes (`applyAction`), when it is complete (`onComplete`). Hooks are **pure**; side
  effects route through declared effects, never I/O inside a hook.

## Key decisions (ADR-028)

| #   | Decision                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `ActivitySession` is the runtime center; domains are first-class **data definitions** (data + hooks, not classes).                                                                |
| D2  | State store = registry slot #14, narrow + authoritative (versioned state only). Trajectory reused from `platform/agents`, written idempotently by the coordinator.                |
| D3  | Action pipeline: effects are the unit of capability **and** risk floor. `effectiveRisk = max(declared, effect floor)` — raise never lower. Ephemeral / durable / two-phase tiers. |
| D4  | Every committed mutation appends ≥1 Step (1:many by `operationId`). Ephemeral actions have no trajectory.                                                                         |
| D5  | Optimistic concurrency, **reject-to-caller**. Atomicity is a store contract (CAS + reduce-commit), conformance-verified by racing commits — provider-independent.                 |
| D6  | Capabilities, not modes. Turn-based ships a universal core; variant machinery is runtime-guarded (throws at registration).                                                        |
| D7  | AUX-shaped returns from day one: `{ result, trajectory, nextActions, cost }`. Opt-out for hot paths.                                                                              |
| D8  | Session events are framework-native; realtime is one optional subscriber (re-envelopes, no adapter drift).                                                                        |
| D9  | Applications registered, not coded. Hooks pure; contract additive-only until a `schemaVersion` trigger.                                                                           |
| D10 | Sessions budget-bounded (optional). Most-restrictive-wins: `min()` of all applicable ceilings, symmetric with D3's `max()` on risk.                                               |

## Public API

**Runtime**

| Export                | Purpose                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `createSession(args)` | Create a session: initial state, persisted at v1, trajectory opened.                                                 |
| `dispatch(args)`      | Run an action through the pipeline: validate → CAS commit → trajectory → event. Returns the AUX shape or a conflict. |
| `isConflict(outcome)` | Type guard — did the dispatch lose the version race?                                                                 |
| `ActionRejectedError` | Thrown when an action is rejected pre-mutation (unknown/invalid/not-your-turn/budget/requires-approval).             |

**State store (slot #14)**

| Export                                                                              | Purpose                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ActivityStateStore<TState>`                                                        | The store contract (create / load / commit / reduceCommit / delete). |
| `InMemoryActivityStateStore`                                                        | Reference impl; default for tests.                                   |
| `SupabaseActivityStateStore`                                                        | Persistent impl (migration 018).                                     |
| `getActivityStateStore()` / `setActivityStateStore()` / `resetActivityStateStore()` | Store singleton (registry sets it; consumers read it).               |

**Action pipeline (pure)**

| Export                                         | Purpose                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `computeEffectiveRisk(spec)`                   | `max(declaredRisk, effect floor)` — the anti-gaming chokepoint.           |
| `resolveTier(spec)` / `requiresTwoPhase(spec)` | Durability-tier classification.                                           |
| `assembleActionContext(args)`                  | Coordinator-only context assembly (identity, operationId, effectiveRisk). |
| `maxRisk` / `riskAtLeast` / `effectFloor`      | Risk-ordering helpers.                                                    |

**Turn-based core (D6)**

| Export                                                                                       | Purpose                                                                      |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `initTurnState` / `currentTurnActor` / `isCurrentTurn` / `advanceTurn` / `removeParticipant` | Universal turn mechanics.                                                    |
| `assertTurnConfigSupported(config)`                                                          | Registration guard — throws on declared-but-unimplemented variant machinery. |

**Events (D8)**

| Export                           | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `subscribeSessionEvents(fn)`     | Subscribe to the session event stream; returns an unsubscribe. |
| `resetSessionEventSubscribers()` | Testing only.                                                  |

Types (`ActivitySession`, `ActivityDefinition`, `ActionContext`, `SessionEvent`, `Capability`,
`EffectType`, `RiskLevel`, `ActionResult`, `VersionedState`, `CommitResult`, `TurnState`, …)
are exported from `./types`.

## Adding a state provider

The store's atomicity guarantee is a contract, not a database feature — a new provider must
supply atomic conditional-commit (CAS) and reduce-commit (RMW), verified by the conformance
kit's concurrency arm. See the **State Provider Authoring Checklist** in `state-store.ts` and
ADR-028; a store that can't provide atomicity fails conformance and cannot register.

## GenAI principles

- **P2 — Agentic Execution:** the action pipeline is bounded, tiered, instrumented.
- **P4 — Structural Safety:** effects-as-capability + risk floors; trust nothing declared.
- **P12 — Economic Transparency:** `cost` in every result; most-restrictive budget.
- **P15 — Agent Identity:** `ActionContext` carries actor + delegation lineage; one pipeline for
  human/agent/service/system actors.
- **P17 — Cognition-Commitment:** propose (held) vs commit (durable), via `operationId`.
- **P18 — Durable Trajectories:** session history _is_ the trajectory — checkpointable,
  reconstructible.

## Gotchas

1. `ActionContext` and `operationId` are minted by the coordinator, never by a consumer.
2. Compare `RiskLevel` via the ordering helpers, never string comparison.
3. Definition hooks must be pure (D9) — side effects go through declared effects (D3).
4. On a CAS conflict, `dispatch` returns a `ConflictResult` and mutates nothing — branch on
   `isConflict()`, do not auto-retry (D5).
5. Ephemeral actions return an un-persisted `VersionedState` (state advanced, version unchanged)
   — do not treat as committed.
6. Do not add turn variant fields (timing, simultaneity) to the core — they live behind the
   registration guard until a real consumer constrains them (D6).

## Related

ADR-028 (application framework), ADR-031 (action identity & lifecycle — stub), ADR-022 (agent
runtime), ADR-018 (realtime), ADR-027 (conformance kits). ADR-029 (agentic workflows) and
ADR-030 (AUX) build on this.
