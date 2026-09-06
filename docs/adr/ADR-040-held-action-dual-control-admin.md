# ADR-040: Held-Action and Dual-Control Admin Experience

Status: Proposed (Phase 5 Sprint 4b — reserved; authored during 4b). Decision maker: Raman Sud.
Related: ADR-039 (agent registry unification — dual-control mechanism), ADR-035 (GenAI-native
governance admin), ADR-030 (AUX nextActions / gating), `platform/agents/gating.ts`,
`platform/agents/approval-policy-store.ts`.

## Context

ADR-039 (F2b) lets a catastrophic config change raise its effectiveRisk above the gating
threshold, so the runtime holds it for an independent human approver, on top of the existing
config-approval two-person policy. Dual-control is going live (a named catastrophic key set, not
empty), which needs an admin surface to see and clear held actions.

## Decision (reserved)

The held-action / dual-control experience is GenAI-native, built on the existing admin paradigms
(AdminPromptBar, ActionConfirmPanel, AUX nextActions) — not bolted-on settings forms:

- Configuring the dual-control key set and the approval-policy rule is done through the command
  bar, planned into governed tool calls, confirmed in ActionConfirmPanel, and versioned (ADR-035).
- A held action surfaces as a first-class conversational state (not an error), with the required
  approver named; follow-ups arrive as AUX nextActions / ActionItem[] (ADR-030) so naming a new
  dual-control key needs no UI code change.
- A pending-approvals / held-actions review surface lets the required approver clear or reject a
  hold conversationally; self-approval stays blocked (config-approval) and the runtime approver
  actorType is enforced by approval-policy (gating.approveHeldAction).
- "Why was this held?" is answerable from the trajectory (effectiveRisk + matched policy rule +
  effects) — GenAI-native transparency (P3/P18).

Full decision + component design authored during Sprint 4b, before the UX code.
