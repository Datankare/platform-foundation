# ADR-041: Escalation SLA and Remedial Action

Status: Proposed (Phase 5 Sprint 4b). Decision maker: Raman Sud.
Related: ADR-024 (human review queue), ADR-016/017 (moderation pipeline), ADR-039 (Guardian on
the runtime — fail-closed to `escalate`), `platform/moderation/review-service.ts`,
`platform/moderation/review-store.ts`.

---

## 1. The end state

Every escalation is **time-bounded**. An item that a human has not resolved within a configured
window is not left in limbo — a reaper applies a **remedial action** whose default is
**fail-closed (block)**, and records it in the trajectory/audit so the automated decision is
attributable.

Three rules, all config-driven and editable through the governance admin:

1. **SLA.** `moderation.escalation_sla_hours` bounds total time in `pending`/`claimed`
   (default 24), clamped to `[min, max]` guardrails; fail-closed to the strictest (shortest)
   window if config is unavailable (P11).
2. **Remedial.** `moderation.escalation_remedial_action` decides what happens on breach.
   Allowed: `block` (default) or `escalate_higher` (re-queue at raised priority + notify).
   **`allow` is not an option** — a timed-out, human-unvouched item never auto-allows.
3. **Reaper.** A sweep (`reapOverdueEscalations()`) finds over-SLA items and applies the
   remedial action, writing an audit + trajectory record (actor = the reaper, not a human).

This closes the hole ADR-039 opened: Guardian fails closed to `escalate`, and `escalate` is now
itself bounded — no escalate-then-forever, no escalate-then-silent-allow.

### Lifecycle

```
  screen() = escalate ──▶ review item: status=pending, createdAt=t0
                              │
              ┌───────────────┼──────────────────────────┐
              ▼               ▼                            ▼
     human resolves      claim expires             now − createdAt > SLA
     (approve/reject)    (→ back to pending)               │
              │                                            ▼
              ▼                                  reaper: remedial action
          resolved                              · block (default)  → fail-closed
                                                 · escalate_higher  → re-queue + notify
                                                 (never allow)
                                                        │
                                                        ▼
                                             audit + trajectory (actor=reaper)
```

---

## 2. Decisions

**D1 — SLA is config, clamped, fail-closed.** `moderation.escalation_sla_hours` (default 24),
with `moderation.escalation_sla_min_hours` / `_max_hours` guardrails. A configured value outside
`[min, max]` is clamped, not rejected. If the SLA config can't be read, use the **min** (shortest)
window — fail-closed (P11), mirroring how the classifier and Sentinel fail closed.

**D2 — Remedial action, secure default.** `moderation.escalation_remedial_action ∈ {block,
escalate_higher}`, default `block`. The reaper never resolves an item to `allow`. `escalate_higher`
re-queues the item at raised priority and emits a notification hook (P10 human oversight, louder),
for orgs that would rather page a human than hard-block on a transient backlog.

**D3 — Reaper is an idempotent sweep, attributable.** `reapOverdueEscalations(now)` selects
`status ∈ {pending, claimed}` with `now − createdAt > sla` and applies the remedial action in one
transition per item, recording a moderation-audit entry + a trajectory step with
`actorType: "system"`, `actorId: "escalation-reaper"`. Idempotent: a reaped item leaves the
over-SLA set, so re-running is safe. Triggered the same way as the other lifecycle sweeps
(`gdpr-deletion`, `guest-lifecycle`) — an authenticated scheduled invocation; the sweep function
is pure and independently testable.

**D4 — `escalate` is a withhold, not an allow (caller contract).** Callers must treat
`action: "escalate"` as _not permitted-yet_ (content withheld pending review), never as `allow`.
The SLA therefore bounds a _withhold_ window (availability), not a fail-open window. This contract
is asserted in the conformance kit so a caller can't quietly treat escalate as allow.

**D5 — Dual-control the controls.** `escalation_sla_*` and `escalation_remedial_action` are
safety-tier config; adding them to `config.dual_control_keys` (ADR-039) is recommended so the SLA
and remedial policy themselves can't be weakened without a second human.

---

## 3. Why now

ADR-039 F3c makes Guardian **fail closed to `escalate`** when it can't complete a screening run.
Without a bounded escalation, that safety improvement would just relocate the risk — an unbounded
`pending` queue is a silent hole (content stuck forever, or, if a caller treats pending as allow,
a fail-open window). D4 + the SLA + a fail-closed remedial default close it end to end.

---

## 4. Consequences

- New config keys (migration): `escalation_sla_hours` (+ min/max), `escalation_remedial_action`,
  all safety-tier, seeded with secure defaults.
- New `review-service` function `reapOverdueEscalations()` + a scheduled invocation.
- Review items already carry `createdAt`/`status`, so no schema change is required for the SLA
  computation; the remedial transition reuses the existing resolve/escalate paths.
- Conformance kit (L21): tests that (a) an over-SLA `pending` item is blocked by the reaper with
  a secure default, (b) `allow` is never a remedial outcome, (c) the reaper is idempotent, and
  (d) a caller treating `escalate` as `allow` fails the contract test.

## 5. Related

ADR-024, ADR-016/017, ADR-039, `review-service.ts`, `review-store.ts`, `config` governance.
