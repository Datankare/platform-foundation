# ADR-040: Held-Action and Dual-Control Admin Experience

Status: Accepted (Phase 5 Sprint 3d — full design authored; implementation 040a-c). Decision maker: Raman Sud.
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
  runtime approver _actorType_ is a person ("user") for every restricted hold — and while the
  gating threshold is `restricted`, every hold is — whatever the approval policy says (the
  TASK-194 addendum below, "restricted ⇒ person"); the versioned `approval-policy-store` rules
  (risk + effects) decide only for actions below `restricted`.
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

## Implementation plan (Sprint 3d — 040a -> 040b -> 040c)

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

## Amendment (v6.0.0, review 10, 2026-10-24) — one hold per change

Review 10 found the same effect governed by two holds. A command-bar action that writes a
dual-controlled config key (`register_agent`, `set_agent_scope`, `set_capability_mapping`, …) was
held as an action — cleared under the action's own permission (`admin_manage_agents`,
`admin_manage_config`) — and, so its write was not held again, the approval carried a capability
that let the write skip the key's hold (review 9). The action's lesser permission thereby cleared
a safety-tier change, against "approve iff independently authorized to edit"; and a claim was not
bound to what its approval covered.

Decided — simplify, not patch:

- **The key's hold is the one hold on a config write.** An action whose effect is a governed config
  write (`COMMAND_BAR_CONFIG_WRITES`) is never held as an action: it goes straight to
  `writeGovernedConfig`, which holds a write to a dual-controlled key under the key's own rules —
  the approver needs the key's tier permission (`config_manage_safety` for a safety key), may not
  be the requester, must be an operator for a shared deployment's platform default
  (`CONFIG_HOLDS.approverRefusal`, as `approvedChangeTarget` for a held config approval), and the
  approval lapses. The command bar reports it held. Actions whose effect is not a config write keep
  the action-level hold (`admin.dual_control_actions`).
- **No capability.** `approval-capability.ts`, `ActionContext.approval` and the redeem path in
  `dispatchConfigTool` are removed: nothing a caller presents lets a write skip its key's hold.
- **The settings that govern holding are held by their own rule**: `config.dual_control_keys`,
  `config.require_two_person_approval` and `admin.dual_control_actions` (`ALWAYS_DUAL_CONTROLLED`).
- **Invariant, test-enforced**: no action is both on `admin.dual_control_actions` (the code's
  default and 052's seed) and a config write, and every handler that writes governed config is
  declared one (`__tests__/r10-one-hold.test.ts`); at runtime a list entry for a config write is
  ignored. Double holds and capability bypasses cannot recur.

**An approval survives a failed run.** A run claims its approval (`approved -> executing`) and ends
it: `executed` when it took effect, `approved` again (compare-and-set) when it failed before taking
effect — the decision answers `approvals.run_failed`, and approving again retries it; a run whose
process died is recovered after a lease by the approval-expiry job (ADR-031 amendment).

**Review 11 (2026-10-24).** An approved run whose outcome is unknown — it did not end within its
lease and left no step — is `indeterminate`, never approved again by the job (ADR-031 amendment).
The approvals surface lists it first and offers two decisions instead of approve/reject:
`mark_executed` (verified that it took effect; the decider needs the hold's permission) and
`reapprove` (verified that it did not; a fresh approval — independent of the requester, under the
hold's own scope rules — run at once, once); both recorded as `approval_decision`. Runbook:
`docs/runbooks/approvals-and-agents.md`.

**A reduction of power is not held (review 11 M-2).** The kill switch must not wait for a second
admin. A change to `agent.trusted_agents` or `agent.capability_features` that a strict diff proves
only removes power — a suspension, a scope subset, a lower token lifetime, a whole mapping removed
— is applied at once by the one admin making it, who must hold the key's tier permission
(`config_manage_safety`, the permission an approver of the held change needs; `admin_manage_agents`
was rejected: an unheld reduction must need no less than approving it), compare-and-set against
the value it replaces, audited and alerted, without two-person approval. A change with any
widening in it is held whole — the diff cannot carry a widening past the hold. Operators suspend
every agent of a tenant at once (`POST /api/operator/tenants/[id]/agents/suspend`).

**Review 12 (2026-10-24).**

- _Capability mappings (H1)._ A `capability_features` change is a reduction only when it adds
  required features to mappings that exist (the same capabilities before and after, each feature
  list a superset). Removing a mapping, emptying it or removing all of them is a widening for a
  consumer that reads an absent capability as needing no features — Playform's
  `evaluateCapability` did — and is held. **The consumer contract:** a capability absent from
  `agent.capability_features` is NOT allowed (never a vacuous pass); a malformed map allows
  nothing; a mapped capability is allowed when every listed feature is held (an explicit empty list
  needs none). `platform/agents/capability-features.ts` (`evaluateCapabilityFeatures`) is the
  reference evaluator; `__tests__/contract/capability-features-contract.ts` is the kit a consumer
  runs against its own. The platform holds removals even under the contract (a removal then
  narrows): an unheld change is proved against what every consumer may do, not what one should.
- _Held changes are applied only onto what they replace (H2)._ Every held config change records
  the value it replaces at request time — `heldPrevious` on a runtime hold (set by the dispatcher,
  never by a caller), `current_value` on a two-person approval — and its approval applies it with
  a compare-and-set against that value. Changed since (a kill switch, a power reduction, another
  approved change): nothing applied, the hold withdrawn and audited, `approvals.stale` (409); the
  requester asks again. A hold that recorded no value is refused the same way. The kill switch and
  every unheld reduction withdraw the pending holds on their key (audited, reason `superseded`).
  Whole-value application had let an approved scope change, requested before the kill switch,
  re-activate every agent the switch suspended.
  _Note, November 1, 2026 (TASK-194, S1 round 23):_ "the hold withdrawn" is the system's act when
  the withdrawal lands (`withdrawn: true` in the answer; the record names the system, the decider
  as `foundBy`), and only when the run's claim was given back. Not landing, a runtime hold stays
  approved — reject it — and a two-person approval is left settling, listed again for the same.
  What changed may be a role (the command bar's role change), not only a setting.
- _Reach and independence (L7)._ A change of either key is published to every instance's config
  cache through the shared cache; the kill switch exists for the current tenant in every
  deployment mode (`POST /api/admin/agents/suspend`, `config_manage_safety`); `mark_executed` is
  refused to the hold's requester, as approval is. Runbook: `docs/runbooks/approvals-and-agents.md`.

**Review 13 (2026-10-24).**

- _The consumer contract is fail closed, and usable (P)._ A malformed **or unreadable**
  `agent.capability_features` allows nothing — there is no built-in fallback map. A consumer's
  "fail-safe" built-in map is a second, ungoverned copy of the policy: falling back to it on an
  outage or a malformed value turns "the policy could not be read" into "allow what the code
  shipped with", and no admin approved that. The platform reads both governed agent keys with
  getConfigOrThrow semantics (`platform/agents/governed-agent-config.ts`: `readTrustedAgents`,
  `readCapabilityFeatures`, `evaluateGovernedCapability`); a consumer must too
  (MIGRATION_v5_to_v6 §1b). The kit runs a consumer's own decision through its seams — the map
  read, the account's features, the decision — so no adapter is written by hand.
- _A reset is compared on what it resets to (M1)._ A held reset records the platform default it
  would inherit; its approval applies only while that default stands (compare-and-set on the
  tenant's row and `platform_config.value`, under the platform lock taken first).
- _Withdrawal follows scope (L1)._ A reduction withdraws the holds of the scope it reduced only: a
  tenant's reduction never withdraws a pending change to the platform default (or the reverse).
- _ABA is accepted (L6)._ The compare-and-set compares values, not versions: a value changed and
  changed back before the approval (A → B → A) passes, and the approved change lands on exactly
  the value its approver was shown. A version column would also refuse it, at the cost of refusing
  every approval whose key was touched and restored (a reduction undone, an edit reverted) — work
  for the requester with no change to what is applied. The intermediate change is in the key's
  history; the runbook (§5) tells an approver to reject when it matters (a kill switch that was then
  undone). `db/r13` asserts the behaviour.

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

## Addendum — TASK-194 (October 2026): "authorized to edit" includes the change's own rules

"Approve iff you can edit" had been read as "hold the edit's permission". A change can need more:
a role change needs every permission of both roles and never a protected role (ADR-013,
`checkRoleAssignment`), a catalog change the standing to change the catalog
(`mayChangePlatformCatalog`). An approver is now held to those rules, evaluated for the approver
against the held payload: `HoldAuthority.approverRuleRefusal`, checked by `decideApproval` on
approve, reapprove and mark_executed — the command bar's `APPROVER_RULES` are the handlers' own
check functions, so the two cannot drift. A rejection is not held to them (it changes nothing).

The irreversible admin action — an account's erasure (`purge_user_data`) — is always held, whatever
`admin.dual_control_actions` says (`ALWAYS_HELD_ACTIONS`): a reversible role change was
dual-controlled while an erasure was one admin's alone. Every route reaching an irreversible effect
is held through such an action or recorded as an accepted single-actor effect with its reason
(`__tests__/irreversible-routes.test.ts`); a user's deletion of their own account is the latter.

An undecided run (`indeterminate`) verified not to have taken effect may also be **withdrawn**
(TASK-194 round 5): decision `withdraw` closes it as `rejected`, never run, recording the decider
and the note — independent of the requester, the hold's permission needed, as for
`mark_executed`. Before, such a hold could only be approved again, which runs it: for a second
erasure hold of one account (held before 061's index) that is a second erasure. A `reapprove` of an
undecided hold its authority finds duplicates an older open one (`duplicateOf`) answers
`approvals.duplicate_undecided` (round 8: its own code, saying to mark it executed or withdraw it)
and changes nothing.

**Whose account it is binds every decision (round 6).** A3 — no decider is the account the held
action acts on (`HoldAuthority.targetAccount`, `admin.self_target`) — was checked on approve,
reapprove and mark_executed only: the target of an erasure holding `admin_purge_user_data` could
withdraw or reject it. It is checked on every decision now, withdraw and reject included: nobody
decides a hold about their own account, in any direction. The change's own rules
(`approverRuleRefusal`, C-2) still bind only the decisions that run the change or declare it done
— a rejection or a withdrawal never runs it. Each decision's audit record (`approval_decision`)
names the decider's note and the hold's previous approver (`note`, `approvedBy`), and the account
the held action acts on as its target, so the note is erased with that account (round 7).

**No one may decide it (round 7).** An undecided run never lapses; when every holder of its
permission in the tenant is its requester or the account it acts on, no one there may decide it
(and an undecided erasure keeps any later erasure of the account from being held). The listing
marks it for a viewer (`PendingApproval.noEligibleDecider`; a decider holds the hold's permission
and `can_access_admin`, one read for every undecided hold — round 8), **Approvals** says a
platform operator decides it, the `approvals.indeterminate` alert says how, and the operator's
tenant settings offer its three decisions — the operator route runs the same `decideApproval`,
under the same rules.

_Previously updated: October 31, 2026 (TASK-194 round 7: no one may decide it; the note erased)._

_Previously updated: October 31, 2026 (TASK-194 round 6: A3 on every decision)._

_Previously updated: October 31, 2026 (TASK-194 round 5: an undecided run withdrawn without
running)._

## Addendum — TASK-194 (October 2026): restricted ⇒ person

A held restricted action — by its effective risk or its effects — is approved by a person, whatever
the approval policy's rules or default say: `resolveApprover` decides it before the policy, and
the stores refuse a rule or a default that would say otherwise (a hand-set default is applied as
"user"). While `GATING_THRESHOLD` is `restricted`, every hold is restricted, so no rule or default
changes who approves a current hold; the policy store stays as a seam for an app or tenant that
lowers the threshold, deciding only for actions below `restricted`. Why, and the history (TASK-145,
the S1 sweep's round 12): ADR-030's amendment of 2026-10-31. The command bar and **Approvals** say
it to an admin who changes the policy.

## Addendum — TASK-194 (November 2026): every lost commit is undecided

An approved run whose write lost its commit (`admin.write_indeterminate`) may have taken effect.
Since the S1 sweep's round 16 its claim is never given back (`ApprovedRunFailedError.released`
false, `LOST_COMMIT_CODE`): the run stays `executing`, and once its lease (`RUN_LEASE_SECONDS`) has
passed the approval-expiry job (`config.expire-approvals`, `recoverStaleRuns`) marks it
`indeterminate` — so every lost commit now lands with the undecided runs of review 11 H-1. That
design stands: an undecided run never lapses and is never decided by a job, because only a person
can say whether it took effect. Its safeguard is the alert: `approvals.indeterminate` is raised
when the run is found undecided, and again at most every `UNDECIDED_REMINDER_HOURS` (24) while it
waits (`alertWaitingUndecided`). Both run in that same job, so the job cannot be turned off (round
18): its schedule is `required` — the scheduler ignores its `enabled` setting; every config write
refuses to turn it off or to give a tenant its own value of it (`jobs.schedule_required`, round
19: the Jobs screen and its route, the config page, an operator's tenant settings, the config
assistant, a held change's approval and an approved two-person change's apply — the store's write
itself refuses it); and migration 062 set the setting on, removed every tenant's override of it and
withdrew every approval still pending for it. A change to it held before then and approved now is
withdrawn by the system, recorded (`approval_withdrawn`, reason `refused`), never kept to be
approved again: a runtime hold through its authority's resume (`HoldResumeResult` `refused`,
round 20), a two-person approval by its apply. A runtime hold withdrawn as stale or refused is the
system's act (round 21: `system:held-change-refused`, the decider recorded as `foundBy`, who had
approved it and when), answered `withdrawn: true` so the screens read the list again — and only
when its run's claim was given back: a claim kept is a run whose outcome is unknown, listed as
undecided for a person, never withdrawn. Only its interval is an operator's, within
its bounds; the screens give the bound — the lease, that interval and a tick. A person clears an
undecided run on **Approvals** — verify, then mark it executed or withdraw it (a config hold may
also be approved again: a retry of one that took effect is refused as stale); where no one in its
tenant but its requester and the account it acts on may decide it, a platform operator does, from
**Operator → Tenants → the tenant → Settings → Held changes**, which lists it
(docs/runbooks/approvals-and-agents.md, "No one may decide it"). A two-person config approval whose
apply lost its commit is the same in its own table: left approved and unapplied, settled by the
same job (`recoverUnappliedApprovals`) from the change's history, its key answering
`approvals.settling` to a new request until then. That the job runner itself has stopped (no tick
arrives) is readiness's to report (`schedule-probe`), not this design's.

_Last updated: November 1, 2026 (TASK-194, round 23: a dated note on H2 — a stale hold withdrawn
when the withdrawal lands)._

_Previously updated: November 1, 2026 (TASK-194 addendum, round 21: a stale or refused hold
withdrawn by the system, only when its claim was given back)._

_Previously updated: November 1, 2026 (TASK-194 addendum, round 20: a change held before the job
was required is withdrawn when approved)._

_Previously updated: November 1, 2026 (TASK-194 addendum, round 19: no config write turns the
approval-expiry job off)._

_Previously updated: November 1, 2026 (TASK-194 addendum, round 18: the approval-expiry job is
required)._

_Previously updated: November 1, 2026 (TASK-194 addendum: every lost commit is undecided)._

_Previously updated: October 29, 2026 (TASK-194 addendum: approver rules; erasure always held)._

_Previously updated: September 8, 2026 (Phase 5 Sprint 3d — ADR-040 full design: unified approvals
surface, approve-iff-authorized-to-edit, safety_approver; implementation 040a-c)._
