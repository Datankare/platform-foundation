# ADR-026: Reconciling the Live Database with PF Migration History

**Status:** Accepted
**Date:** 2026-06-07
**Phase / Sprint:** Phase 4 — Sprint 6 follow-up (schema reconciliation)
**Related:** ADR-006 (Database Architecture), ADR-012 (Auth Architecture), ADR-013 (Role Hierarchy), migrations 005 / 009 / 015 / 016 / 021

## Context

The live database was provisioned ad hoc and has no `supabase_migrations.schema_migrations` table — there is no record of which PF migrations were applied. A reconciliation audit (triggered during Sprint 6 close-out, when migration 018's `moderator`-role insert behaved unexpectedly) introspected the live schema (`information_schema`, `pg_policies`, `pg_proc`, `pg_trigger`) and compared it against the object signatures of PF migrations 001–020.

The result: the live DB is a **partial, non-linear** application of the migration set. Present and consistent: 001–004, 006–008, 010–014, 017–018. Absent entirely: 005 (the `super_admin` role + the `admin_*` permission rename), 009 (GDPR purge log), 015 (social data model), 016 (agent runtime). Two of the missing migrations contained latent bugs that would prevent them applying on _any_ database:

- **009** — its RLS policy referenced `public.profiles` (`profiles.role = 'super_admin'`), a table that does not exist in PF's model (the model is `public.users` + `roles` via `users.role_id`, post-008). `CREATE POLICY` against a non-existent table errors at creation, so 009 could never apply.
- **016** — its `platform_config` seed supplied only `(key, value, description, updated_by)`, but `category` / `value_type` / `permission_tier` are `NOT NULL` and `updated_by` is `UUID` (it passed the text `'migration-016'`). It failed two independent ways.

Critically, the deployed code already assumed the post-005 world: admin route guards key on `admin_view_audit` / `admin_manage_roles` / `admin_manage_users`, and the code treats `super_admin` as a real role (GDPR purge, config safety tier, `PROTECTED_ROLES`). The live DB was therefore inconsistent with the code running on top of it — several admin routes would have failed had they been exercised. Because the platform is pre-launch with no user accounts, none were.

## Decision

Reconcile the live database **forward** to match PF. PF remains the canonical source of schema truth; the database is brought into line with it, not the reverse.

1. **Permission vocabulary (the 005 slice) via a new forward migration `021`.** Rename the surviving `can_*` admin permissions to `admin_*` (`UPDATE permissions SET code = …`, which preserves existing grants since `role_permissions` keys on `permission_id`), add the two code-required permissions absent here (`admin_manage_config`, `admin_manage_users`), and add the `super_admin` role with a grant of all permissions. 005 itself is _not_ replayed — parts of it were already superseded (its `admin_manage_config` by 011's config tiers; its `admin_manage_players` by the 008 user rename), so `021` targets the vocabulary the code actually guards on.

2. **Governance split (strict 005).** `admin_manage_roles`, `admin_manage_config`, and `config_manage_safety` are granted to `super_admin` only; `admin` keeps the operational set, including the newly added `admin_manage_users`. Role management and governance config therefore require `super_admin`.

3. **Fix the two latent PF bugs in place.** Because neither 009 nor 016 had ever applied anywhere, editing the migration files directly is safe — no database holds the old version to conflict with. 009's policy becomes a `service_role` policy (`purge_log_service_all`), consistent with the other server-side tables (`review_queue`, `user_strikes`, `agent_*`), with `super_admin` read enforced at the API layer where the GDPR route already gates it. 016's seed is rewritten to the working 013/014 column pattern.

4. **Apply the three missing migrations** (corrected 009, 015, corrected 016) to the live DB, in order, and verify by object.

5. **Scope: object-level.** Reconciliation covers tables, ENUM types, RLS policies, triggers, functions, and config keys. Column-level parity for the previously-present tables is assumed — they applied via their own migrations and their signature objects match — not exhaustively diffed.

## Consequences

**Positive**

- The live DB matches PF's expected post-020 schema; the admin routes the code guards (audit, roles, users, config) now resolve against real permissions, and `super_admin` exists for the governance-gated paths.
- The social, agent-runtime, and GDPR-purge Supabase stores can now persist — previously their tables were absent here and only the InMemory implementations worked.
- Two latent PF bugs (009's policy, 016's seed) are fixed for any future clean apply of the template.

**Negative / risks**

- The live DB still has no migration-tracking table, so drift can recur. Future migrations must be applied deliberately and verified by introspection, not assumed from the migration number.
- Column-level parity was assumed rather than exhaustively diffed; a later column-level audit may surface finer drift.
- Reconciliation was performed manually via the dashboard SQL editor (no CLI/migration history), so the sequence is recorded only here and in the migration files.

**Neutral**

- `021` is a forward reconciliation migration rather than an edit to applied history; 009 and 016 were edited in place specifically because they had never successfully applied.
- Under the strict split, using the password-policy / guest-config / safety-config routes requires a `super_admin` account (assigned directly in the DB by design, since the UI cannot grant `super_admin`).

## Alternatives considered

- **Regress PF to the live DB's `can_*` / no-`super_admin` vocabulary.** Rejected: inverts the PF-leads build rule and would unwind both working code and the 005 security hardening (super_admin separation).
- **Replay 005 verbatim.** Rejected: parts of 005 were already superseded (config tiers, the user rename), so it would re-introduce dead permissions; a forward `021` targeting the code's real vocabulary is cleaner.
- **Full migration-history rebuild (drop and replay 001–020).** Rejected: high risk on a live database and unnecessary when only three migrations were genuinely missing.
