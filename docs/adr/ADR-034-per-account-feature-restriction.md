# ADR-034 — Per-account feature restriction

Status: Accepted (Sprint 3c F1).
Spec basis: ADR-013 (role hierarchy), ADR-009 (security standards), Sprint 3c B-gov
(account_status feature governance). Extends the account-status guard
(`platform/auth/account-status-guard.ts`).

## Context

The account-status guard (B-gov) governs features by ACCOUNT STATUS: a user in the
`restricted` or `suspended` status is blocked from a globally-configured set of features
(`account_status.restricted_features` / `suspended_features`). The block is a property of the
STATUS, and the feature set is the same for every user in that status.

This cannot express a targeted, per-user feature block. Two needs it misses:

- Block ONE feature for ONE user without changing their standing — e.g. an otherwise-healthy
  `active` user who abused a single capability, where moving them to `restricted` would be
  disproportionate (it carries timestamps, review-queue presence, "your account is
  restricted" messaging, and blocks whatever else is in the global restricted set).
- Different per-user blocks — user A barred from feature X, user B from feature Y — which a
  single global per-status list cannot represent.

## Decision

Add a per-account feature block that is ORTHOGONAL to account status: a specific user can be
blocked from a specific feature regardless of whether they are `active`, `warned`,
`restricted`, or `suspended`.

- Storage: a `user_feature_restrictions` table — `(user_id, feature)` rows, with
  `created_by` / `reason` / `created_at` for the audit trail. Durable per-account data (not
  global config; config is platform-wide, this is per-user).
- Check: in `checkAccountStatus`, immediately after the unknown-feature fail-closed check and
  BEFORE account state is loaded. If the feature is on the user's block-list, deny — for any
  status. This placement is what makes it orthogonal: it does not depend on, and is not
  short-circuited by, the `active`/`warned` allow path.
- The status-based checks (restricted/suspended/banned) are unchanged and still run for users
  not caught by a per-account block.

### Why orthogonal, not an extension of the status lists

The rejected alternative was to make the per-status feature sets per-account (so restricting a
user lets you choose which features their restriction covers). That was rejected because it
COUPLES a feature block to a status change: to block one feature you must first move the user
to `restricted`/`suspended`, dragging along every side effect of that status and making a
surgical action heavyweight — and it still cannot block a feature for an `active` user in good
standing. Decoupling the block from status is the whole point of F1.

### Fail-closed posture (the one real tradeoff)

Two loaders with DELIBERATELY DIFFERENT failure behavior:

- `loadAccountState` (existing) fails CLOSED to `banned` on a DB error — you cannot prove a
  user is in good standing, so deny. Unchanged.
- The per-account block-list loader fails OPEN FOR ITS OWN LAYER on a DB error: a load failure
  is treated as "no per-account block" and the guard proceeds to the normal status checks
  (which still fail closed on their own outage). The failure is logged loudly.

The asymmetry is intentional and proportionate. The block-list is an ADDITIVE exception on top
of an otherwise-allowed user; failing it closed (deny-all) would turn a transient per-user
table hiccup into a total feature outage for the ENTIRE platform, which is a worse failure than
briefly not enforcing a targeted block. The base status checks still gate every request, so a
block-list outage degrades to "targeted per-user blocks temporarily unenforced," not "everyone
locked out." The rejected alternative (fail the whole guard closed on a block-list outage) was
weighed and declined for that disproportion; the loud log on load failure keeps the gap
visible for operators. This is the conscious tradeoff, recorded so it is a decision and not an
accident.

## Consequences

- A targeted feature block becomes a surgical, low-drama admin action: one row, no status
  change, no side effects, full audit (`created_by`/`reason`).
- The guard mechanism stays in platform-foundation (PF-owned, synced): PF gains a generic
  per-account restriction layer; no Playform vocabulary enters PF.
- Orthogonality means a per-account block and a status-based restriction can BOTH apply; the
  per-account block is checked first, so it takes precedence and denies earliest.
- A per-account block-list DB outage does not fail the platform closed; it is logged and the
  targeted blocks are briefly unenforced while base status governance continues. Operators
  must monitor the load-failure log.
- The admin surface to manage per-account blocks (list/add/remove, with reason) is a UX-track
  item (Sprint 3c U6, per-account control); F1 ships the mechanism and the governed data model.
