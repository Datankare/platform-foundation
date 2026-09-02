# Sprint 3c — F1: Per-account feature restriction. Design.

Status: ACCEPTED (2026-08-30). Implements ADR-034.
Spec basis: ADR-034, Sprint 3c B-gov (account-status feature governance).

## 1. What F1 delivers

A per-account, per-feature block that is orthogonal to account status (ADR-034): an admin can
bar a specific user from a specific feature without changing that user's standing. The block is
checked inside the existing account-status guard and takes precedence over the status path.

## 2. Repo boundary

`platform/auth/account-status-guard.ts` is PF-owned (synced to Playform). F1 is a PF commit:
it extends the generic guard mechanism. No Playform vocabulary enters PF — the block-list is
keyed by user id and an opaque feature string, exactly like the existing status feature lists.

## 3. Design

### 3a. Storage — `user_feature_restrictions`

A durable, per-account table (not global config):

    user_id     uuid     not null   -- the restricted user
    feature     text     not null   -- opaque feature string (same vocabulary as the guard)
    reason      text                -- why (audit)
    created_by  text     not null   -- who applied it (audit)
    created_at  timestamptz not null default now()
    primary key (user_id, feature)

RLS: service_role only (the app layer enforces admin scope, as with the other guard data).
Indexed by `user_id` for the per-request lookup. A composite PK makes (user, feature) unique —
adding the same block twice is a no-op.

### 3b. Loader — `loadUserFeatureRestrictions(userId)`

Returns the set of features blocked for that user (a `readonly string[]`). On a DB error it
returns an EMPTY set and logs loudly (ADR-034 fail-open-for-this-layer): the additive block is
skipped, the base status checks still run. This is the deliberate asymmetry vs `loadAccountState`
(which fails closed to `banned`).

### 3c. Guard order (the insertion)

`checkAccountStatus(userId, feature)` gains one check, placed to be orthogonal to status:

1. userId format validation (unchanged)
2. unknown-feature fail-closed (B-gov, unchanged)
3. **per-account block check (NEW): if `feature` is in
   `loadUserFeatureRestrictions(userId)`, DENY — regardless of status.**
4. loadAccountState (unchanged)
5. active / warned → allow (unchanged)
6. restricted / suspended → status feature lists + expiry (unchanged)
7. banned → deny all (unchanged)

Placing the new check at step 3 — before state is loaded and before the active/warned allow —
is what makes the block independent of status. A blocked feature denies for an `active` user
just as for a `restricted` one.

### 3d. Deny result

Mirrors the guard's existing result shape: `{ allowed: false, reason, accountStatus, feature }`.
The `accountStatus` reported is the user's ACTUAL status (loaded for the message even on a
per-account block, so the response is truthful about standing), and `reason` names a
per-account restriction without leaking the block's reason text to the end user.

## 4. RAMPS / GenAI mapping

- Security (RAMPS): a least-privilege, targeted control — revoke one capability without a
  blunt status change. Fail-open-for-layer is a proportionate availability choice, logged.
- P10 / P17 (GenAI): human-governed, audited (`created_by`/`reason`); the block is explicit
  admin intent, not an inferred consequence.
- P11: the base status governance remains fail-closed; only the additive layer degrades
  open on its own outage, and never silently — the load failure is logged.

## 5. Test matrix (complete)

- active user, feature on their block-list → DENY (the core orthogonality case).
- warned user, feature on their block-list → DENY.
- active user, feature NOT on their block-list → allow (unchanged behavior).
- restricted user, feature on their per-account block-list → DENY at the per-account step
  (before the status list is even consulted).
- block applies only to the named feature: a user blocked from X can still use Y.
- block is per-user: user A blocked from X; user B (no block) uses X freely.
- block-list DB outage → the layer is skipped (no deny from it), base status checks still run,
  and the failure is logged.
- unknown feature still fails closed ahead of the per-account check (B-gov precedence).
- banned user is denied regardless (unchanged).

## 6. Out of scope (deferred)

- The admin UI to list/add/remove per-account blocks with a reason — Sprint 3c U6
  (per-account control panel). F1 ships the mechanism + data model; U6 ships the surface.
