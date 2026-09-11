# ADR-040: Held-Action and Dual-Control Admin Experience

Status: Accepted (Phase 5 Sprint 4b — full design authored; implementation 040a-c). Decision maker: Raman Sud.
Related: ADR-039 (agent registry unification — dual-control mechanism), ADR-035 (GenAI-native
governance admin), ADR-030 (AUX nextActions / gating), `platform/agents/gating.ts`,
`platform/agents/approval-policy-store.ts`.

## Context

ADR-039 (F2b) lets a catastrophic config change raise its effectiveRisk above the gating
threshold, so the runtime holds it for an independent human approver, on top of the existing
config-approval two-person policy. Dual-control is going live (a named catastrophic key set, not
empty), which needs an admin surface to see and clear held actions.

## Decision

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

## Approver model — approve iff independently authorized to edit

A held change may be cleared only by an actor who **(a) independently holds the permission
required to make that change and (b) is not the requester**. This one rule governs _both_ hold
mechanisms (runtime dual-control and config-approval); it invents no permission vocabulary
because the requirement is _derived_, not maintained:

- **Config-key holds** — the required permission is the key's own edit gate, read from
  `platform_config.permission_tier`: `safety` -> `config_manage_safety`, `standard` ->
  `config_manage_standard`. Unknown keys fail closed to `safety` (P11), as the config read path
  already does.
- **Runtime tool-proposal holds** (no config key) — fail closed to `config_manage_safety`; the
  runtime approver _actorType_ (user/agent/system) is still decided by the existing versioned
  `approval-policy-store` rule (risk + effects), unchanged.
- **Enforcement** is server-side and never trusted from the client:
  `hasPermission(decidedBy, requiredPermission) && decidedBy !== requester`. `super_admin`
  seed-holds every permission, so break-glass ("may approve anything") falls out with no special
  case.

Because the requirement is derived from the key's tier, a new safety key is covered the instant it
is marked safety-tier — the approver policy cannot drift behind the key set, which is the failure
mode ADR-039/041 exist to prevent. This retargets `config-approval`'s existing gate from "a
_different super_admin_ approves" to "an _independent holder of `config_manage_safety`_ approves,"
so the two gates converge on one rule rather than two vocabularies (exact call site confirmed at
040b).

### `safety_approver` role (new)

Two-person control must not require **two `super_admin`s**: two apex, all-powerful principals
co-signing is not separation of duties, inflates the number of maximum-privilege accounts, and
either could act unilaterally anyway. `super_admin` stays a singleton. A dedicated _lesser_
principal makes dual-control operable at **one `super_admin` + one `safety_approver`**.

`safety_approver` is a safety **peer**, not a pure reviewer — it holds the edit authority, so
"approve iff authorized to edit" still holds and no `approve_*` permission is invented:

| Granted (existing permissions)    | Purpose                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `config_manage_safety`            | Edit _and_ approve safety-tier config — the authority the rule requires      |
| `can_access_admin`, `config_view` | See the held change and its "why held" trajectory — prevents rubber-stamping |

Deliberately **excluded**: `admin_manage_roles` (no self-escalation), `admin_manage_users`,
`admin_manage_entitlements`, and the broader governance set — so the role cannot drift into a
shadow `super_admin`. A `safety_approver`'s own safety changes are themselves held and cannot be
self-approved (`decidedBy !== requester` + config-approval's self-block). The role is assigned by
`super_admin` through the normal **audited** role-management (`admin_manage_roles`); it is _not_
DB-only like `super_admin` — it cannot self-escalate, so a DB-only bar would only recreate the
operability problem this role exists to solve.

## Surface architecture (unified)

A single `PendingApproval` view-model that both hold records map into, discriminated by `source`:

- **Adapter** — `ProposalRecord` (runtime dual-control) and `ConfigApprovalRecord` (config-approval
  two-person) each map to a common `PendingApproval` (`source: "runtime" | "config-approval"`, id,
  label, effects, effectiveRisk, requester, requiredPermission, eligible approver role(s),
  createdAt, why). A third hold source later is one more adapter, not a new panel.
- **Backend** — `listPendingApprovals()` merges `proposalStore.query({ status: "proposed" })` and
  the config-approval pending query into `PendingApproval[]`, computing `requiredPermission` per the
  approver model and the role(s) that hold it. `GET /api/admin/approvals` lists;
  `POST /api/admin/approvals/[id]` (`{ decision: "approve" | "reject", note }`) dispatches to
  `gating.approveHeldAction` / `rejectHeldAction` or config-approval, after the server-side approver
  check.
- **UI** — `HeldActionsPanel` in `AdminShell`: each hold shows **what** (label / key + payload),
  **why** (effectiveRisk + matched rule + effects, from the trajectory — P3/P18), **who may
  approve** (the role(s) holding `requiredPermission`), and **when**; approve/reject carries a note.
  Holds also render as first-class conversational state and as AUX `ActionItem`s (approve-by-
  conversation) over the _same_ route — deterministic core, conversational layer on top.

## RAMPS acceptance criteria (gating, not aspirational)

- **Reliability** — the stores are the durable source of truth; approve/reject is idempotent
  (gating returns `already-decided`); a stale approval is refused via `observedVersion`.
- **Accessibility** — `HeldActionsPanel` is fully keyboard-operable with ARIA roles/labels and
  screen-reader announcements; a11y assertions are part of the conformance kit, not a follow-up.
- **Manageability** — every decision is audited (`decidedBy` / `decidedAt` / `decisionNote`); "why
  held" is reconstructable from the trajectory; one surface covers both gates.
- **Performance** — bounded queries (status filter + `limit`); poll-on-load for v1 (a low-frequency
  admin surface does not warrant push; SSE is a later extension).
- **Security** — approver-policy and self-approval are enforced server-side and never trusted from
  the client; routes are permission-gated; the underlying change is already dual-controlled;
  `safety_approver` cannot self-escalate.

## Implementation plan (Sprint 4b — 040a -> 040b -> 040c)

- **040a — read surface.** `PendingApproval` view-model + adapters, `listPendingApprovals()`,
  `GET /api/admin/approvals`, `HeldActionsPanel` (list + "why held"). No state change. Conformance +
  a11y tests.
- **040b — decision surface + role.** `POST /api/admin/approvals/[id]` -> gating / config-approval,
  with server-side approver-policy + self-approval + stale-approval; the **`safety_approver` seed
  migration**; config-approval gate retargeted to `config_manage_safety`. Conformance kit below.
- **040c — conversational + policy management.** Holds/approve as AUX `ActionItem`s in
  `AdminPromptBar` (approve-by-conversation); manage the `dual_control_keys` set (and, where
  applicable, the approval-policy rules) via the command bar as a governed, _itself dual-controlled_
  action.

## Conformance kit (L21)

- A `safety_approver` who is not the requester **can** approve a safety hold; the trajectory
  resumes.
- The requester **cannot** self-approve — **even a `super_admin`** (`decidedBy !== requester`).
- A plain `admin` **cannot** approve a safety hold (lacks `config_manage_safety`).
- `super_admin` break-glass **can** approve any class.
- Approve/reject is idempotent (`already-decided`); a stale approval (`observedVersion` mismatch) is
  refused.
- `listPendingApprovals()` returns only live holds, from both sources, each with the correct
  `requiredPermission`.
- `HeldActionsPanel` a11y: keyboard reachable, roles/labels present, a self-owned hold renders its
  approve control disabled.

## Alternatives considered

- **Runtime-holds-only surface** — rejected: leaves config-approval holds with no surface, the same
  limbo this ADR removes.
- **Pure-conversational approve** — rejected: a catastrophic clear needs a deterministic, testable
  core; conversation layers over it.
- **Two `super_admin`s as the approver pair** — rejected: two apex principals co-signing is not
  separation of duties and inflates maximum-privilege accounts; hence `safety_approver`.
- **Pure-reviewer role with a narrow `approve_*` permission** — rejected: a hyper-narrow role that
  breaks "approve iff can edit" and invites rubber-stamping; `safety_approver` is a safety _peer_
  holding `config_manage_safety` instead.
- **Per-domain named approvers (finance / trust-safety) now** — deferred: no domain roles exist and
  these would be speculative narrow roles; the tier-derived rule already differentiates by class,
  and per-domain roles slot in later as plain grants with no code change.

_Last updated: September 8, 2026 (Phase 5 Sprint 4b — ADR-040 full design: unified approvals
surface, approve-iff-authorized-to-edit, safety_approver; implementation 040a-c)._
