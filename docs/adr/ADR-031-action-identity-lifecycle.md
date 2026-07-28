# ADR-031: Action Identity & Lifecycle Protocol

**Status:** Accepted (supersedes the Sprint 1 stub)
**Date:** 2026-07-26
**Decision Makers:** Raman Sud
**Sprint:** Phase 5 Sprint 1 (stub) / Sprint 2 (full protocol)
**Related:** ADR-028 (application framework — D3 action pipeline, D4 trajectory, D5 concurrency), ADR-029 (agentic workflow framework), ADR-022 (agent runtime)

## Context

ADR-028 D3 established `operationId` as the stable identity of a logical action across five
stages — proposal(s), approval, state commit, external effect, trajectory persistence — and
stated the idempotency rules the Sprint 1 `SessionService` implements. Sprint 1 built the
direct-commit path. Sprint 2 builds the two-phase path (ADR-029), and the two-phase path is
where identity stops being bookkeeping and starts being the correctness argument: an approval
that arrives after the state has moved, a commit that succeeds while the process dies before
the trajectory append, an external effect retried against a downstream that is not idempotent.

This ADR specifies the full state machine, the dedup guarantee at each edge, and the
reconciliation rules. It supersedes the stub.

Two defects in the Sprint 1 implementation are in scope, because both make a stated guarantee
unreachable rather than merely unimplemented:

1. **`operationId` is minted inside `dispatch()`** (`op_${generateSecureId()}`) and
   `DispatchArgs` exposes no field for it. A retried dispatch therefore mints a _new_
   identity, so the D3 guarantee that a retried commit returns the existing version cannot
   hold through the public API. Identity must be supplied by the caller for retries to mean
   anything.
2. **`assembleActionContext()`'s return value is discarded** — it is called for effect and the
   result is never assigned. `effectiveRisk`, `boundary`, and `effects` are computed and thrown
   away, so they never reach the trajectory step or the `SessionEvent`. The audit record is
   missing precisely the fields that justify the action.

## Decision

### D1 — `operationId` is minted at intent, and is caller-suppliable

`operationId` is the identity of the logical action, stable across all five stages. It is
minted by the coordinator at intent — never by a domain hook, never derived from payload
content.

`DispatchArgs` and the propose/approve entry points accept an optional `operationId`. When
absent, the coordinator mints one (current behaviour, unchanged for first attempts). When
present, it is the idempotency key: the coordinator MUST treat the call as a retry of that
logical action and MUST NOT produce a second commit, a second external effect, or a second
trajectory lineage.

Callers that want retry safety must therefore mint-and-retain before the first attempt. This
is the only way the D3 guarantee is expressible; a coordinator-minted-only identity makes
every retry a new action by construction.

`sessionId` remains 128-bit (`generateSecureId`) because it gates access. `operationId` is an
audit and idempotency key rather than a capability, but is minted at the same strength — a
guessable operation id would let a caller collide with another actor's in-flight operation and
observe or suppress its result.

### D2 — Five-stage state machine

```
intent ──▶ proposed ──▶ approved ──▶ committed ──▶ effected ──▶ recorded
             │             │
             ▼             ▼
          rejected      superseded
```

| Stage        | Produces                      | Durable? | Terminal |
| ------------ | ----------------------------- | -------- | -------- |
| `intent`     | `operationId`                 | no       | no       |
| `proposed`   | `proposalId`, held cognition  | yes      | no       |
| `approved`   | approval record + approver id | yes      | no       |
| `rejected`   | trajectory, no `stateVersion` | yes      | **yes**  |
| `superseded` | trajectory, no `stateVersion` | yes      | **yes**  |
| `committed`  | `stateVersion`                | yes      | no       |
| `effected`   | external effect receipt       | yes      | no       |
| `recorded`   | trajectory lineage complete   | yes      | **yes**  |

Direct-commit actions (tier `durable`) skip `proposed`/`approved` and move `intent → committed
→ effected → recorded`. Ephemeral actions (tier `ephemeral`) are outside this protocol
entirely — no identity is retained, no stage is durable. This is why `resolveTier()` runs
before anything else in the coordinator sequence.

### D3 — `proposalId` is scoped under `operationId`

`proposalId` exists only when an operation can carry multiple proposals — a revisable gated
action. Direct-commit actions have none. A revision mints a new `proposalId` under the same
`operationId` and marks the prior proposal `superseded`.

One `operationId` therefore has at most one `stateVersion` and at most one external effect, but
may have many `proposalId`s. Any structure that inverts this — a proposal spanning operations,
or an operation committing twice — is a protocol violation, not a variant.

### D4 — Dedup handle at every edge

| Edge                 | Dedup key                    | Retry behaviour                                        |
| -------------------- | ---------------------------- | ------------------------------------------------------ |
| intent → proposed    | `operationId` + `proposalId` | returns the existing proposal, does not mint a second  |
| proposed → approved  | `proposalId`                 | second approval of the same proposal is a no-op        |
| approved → committed | `operationId`                | returns the existing `stateVersion`, does not re-apply |
| committed → effected | `operationId`                | effect deduped downstream on `operationId` (see D7)    |
| effected → recorded  | `operationId`                | one logical action = one trajectory lineage            |

Every edge is idempotent on its key. The state store's `commit(sessionId, expectedVersion,
state, operationId)` already carries `operationId` for this purpose; D1 makes it reachable.

### D5 — Stale-approval reconciliation

An approval carries the `stateVersion` observed when the proposal was created. Between proposal
and commit the state may advance (ADR-028 D5 optimistic concurrency). On commit:

- **Version unchanged** — commit proceeds.
- **Version advanced, action commutative** — commit proceeds via `reduceCommit`, which applies
  against latest by construction. Commutativity is declared per action type in `ActionSpec`.
- **Version advanced, action non-commutative** — the approval is **stale**. The commit is
  rejected, the proposal is marked `superseded`, and the operation returns to `proposed` with a
  new `proposalId` under the same `operationId`.

Stale approvals are never silently re-applied against newer state. An approver approved a
specific transition from a specific state; applying it to a different state is a different
action wearing the same approval. The re-proposal keeps the operation's identity so the audit
trail shows one logical action with a revision, not two unrelated attempts.

### D6 — Crash-window repair

The window between `committed` and `recorded` is the only place where durable state can exist
without a complete audit record. The protocol is commit-first, record-after — the reverse would
allow a recorded action that never happened, which is strictly worse than an unrecorded action
that did.

Reconciliation is therefore **forward-only** and driven by the state store, which is the
authority:

1. A commit writes `producedBy = operationId` into `VersionedState` (already in the Sprint 1
   type). This is the repair anchor.
2. On session load, any `producedBy` without a corresponding terminal trajectory lineage
   indicates an interrupted operation.
3. Repair replays the missing tail — trajectory append and event emission — from the committed
   state. It never re-applies the state transition and never re-fires the external effect.

An interrupted operation is completed, not rolled back. Rollback would require undoing a
committed state transition that other actors may already have observed.

### D7 — External-effect idempotency contract

External effects are the one stage the framework cannot make idempotent by itself. The contract
is explicit rather than assumed:

- Any action declaring the `externalCall` or `sendMessage` effect MUST supply an idempotency
  key derived from `operationId` when invoking the downstream.
- Downstreams that accept an idempotency key (most payment, messaging, and mail APIs) receive
  `operationId` directly.
- Downstreams that do not are wrapped in an **effect ledger**: a durable record keyed by
  `operationId`, written before the call and resolved after it. A retry that finds an unresolved
  ledger entry does not re-fire; it reconciles by querying the downstream where that is
  possible, and otherwise surfaces the operation as `indeterminate` for human resolution.
- `indeterminate` is a real terminal state for external effects and MUST NOT be collapsed into
  success or failure. A silent guess here is an at-most-once or at-least-once violation
  depending on which way it guesses.

This is the boundary where P17 (cognition-commitment) stops being an internal discipline and
becomes an integration contract.

### D8 — Identity exists before commitment

A rejected or superseded proposal has an `operationId` and a trajectory, and never a
`stateVersion`. The cognition is recorded; the commitment did not occur.

This is the durable form of the P17 boundary: the reasoning that led to a rejected proposal is
as auditable as the reasoning that led to a committed one. A protocol that discards rejected
proposals cannot answer why an action did not happen, which is the question audits usually ask.

### D9 — `ActionContext` reaches the trajectory and the event

The assembled `ActionContext` — `operationId`, `proposalId`, `actor`, `boundary`, `effects`,
`effectiveRisk` — MUST be carried into the trajectory `Step` and the emitted `SessionEvent`.
It is the justification record for the action.

This corrects the Sprint 1 defect where `assembleActionContext()` is invoked for effect and its
result discarded. The computation exists; only the wiring is missing. Per L11, no abstraction
ships without its consumers wired — a computed-and-dropped context is that rule failing quietly.

## Invariants

These hold at every stage and are the conformance kit's assertions (L21):

1. One `operationId` yields **at most one** `stateVersion`.
2. One `operationId` yields **at most one** external effect.
3. One `operationId` yields **exactly one** trajectory lineage.
4. `proposalId` never appears without an enclosing `operationId`.
5. A `stateVersion` never exists without a `producedBy` naming its `operationId`.
6. A terminal-rejected or superseded operation never acquires a `stateVersion`.
7. Replaying any stage with the same identity is a no-op returning the original result.
8. Ephemeral actions produce none of the above and are outside the protocol.

## Consequences

**Positive.** Retry becomes safe at every edge rather than at none. The crash window has a
defined repair with a defined authority. Approval is bound to the state it was granted against,
so a gated action cannot be laundered onto newer state. Rejected reasoning is preserved.
External-effect indeterminacy is surfaced instead of guessed.

**Negative.** Callers that want retry safety must mint and retain `operationId` themselves —
the framework cannot infer that two calls are the same intent. The effect ledger is real
infrastructure with its own durability requirements, and `indeterminate` operations require a
human resolution path that does not exist yet. Both are ADR-029 implementation scope.

**Neutral.** The state machine adds two terminal states (`rejected`, `superseded`) that
Sprint 1 did not model. Existing direct-commit behaviour is unchanged: those actions traverse
`intent → committed → effected → recorded` exactly as they do today.

## Conformance requirements (L21)

The ADR-029 conformance kit MUST include arms for:

- **Retry idempotency** — same `operationId` replayed at each of the five edges yields the
  original result and no duplicate commit, effect, or lineage.
- **Stale approval** — approval against an advanced version supersedes rather than commits, for
  non-commutative actions; commits for commutative ones.
- **Crash-window repair** — a commit with no trajectory tail is completed forward on load,
  without re-applying state or re-firing the effect.
- **Indeterminate effect** — an unresolved ledger entry surfaces as `indeterminate` and is
  never collapsed to success or failure.
- **Identity-before-commitment** — a rejected proposal has a trajectory and no `stateVersion`.

## Related

ADR-028 (application framework — D3 action pipeline, D4 trajectory append, D5 optimistic
concurrency), ADR-029 (agentic workflow framework — implements this protocol), ADR-022 (agent
runtime — `Trajectory`, `Step`, `StepBoundary` reused here).
