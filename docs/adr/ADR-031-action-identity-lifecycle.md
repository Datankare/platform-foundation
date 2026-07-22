# ADR-031: Action Identity & Lifecycle Protocol

**Status:** Proposed (stub — full protocol authored alongside ADR-029, Phase 5 Sprint 2)
**Date:** 2026-07-22
**Decision Makers:** Raman Sud
**Sprint:** Phase 5 Sprint 1 (stub) / Sprint 2 (full)

## Context

ADR-028 (D3) establishes `operationId` as the stable identity of a logical action across five
stages — proposal(s), approval, state commit, external effect, trajectory persistence — and states
the idempotency rules Sprint 1's SessionService implements. The full lifecycle state machine and
its dedup/reconciliation guarantees are their own protocol, most of which (two-phase, external
effects) lands in Sprint 2 with the agentic workflow framework (ADR-029). This stub reserves the
number and records the spine; the full protocol supersedes it.

## Decision (spine — established in ADR-028 D3)

- `operationId` is the identity of the logical action, minted at intent by the coordinator (never
  by the consumer), stable across all five stages.
- `proposalId` is scoped under `operationId`, present only when an operation can have multiple
  proposals/revisions (revisable gated actions). Direct-commit actions have none.
- Per-stage dedup handles: propose → `operationId` (+ `proposalId`); commit → `operationId` →
  `stateVersion` (retried commit returns the existing version); external effect → deduped on
  `operationId`; trajectory → `operationId` (one logical action = one lineage).
- A rejected proposal has an `operationId` + trajectory (P17 cognition, held) but never a
  `stateVersion` — identity exists before commitment.

## To be specified (full ADR-031, Sprint 2)

- Full state machine: intent → proposal(s) → approval → commit → external effect → trajectory.
- Dedup guarantee at each edge; the propose→approve→commit reconciliation when state advances
  between proposal and commit (stale-approval semantics from ADR-028 D5).
- Reconciliation/repair for the crash window (state committed, trajectory/effect not yet applied).
- External-effect idempotency contract for non-idempotent downstreams.

## Related

ADR-028 (application framework — D3 action pipeline, D5 concurrency), ADR-029 (agentic workflow
framework, forthcoming).
