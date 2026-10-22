-- 042_password_policy_scope_unique.sql — one password policy per scope (Sprint 7X)
--
-- password_policy holds a global row (no role, no user), role rows and user rows. Nothing made a
-- scope unique, so the admin routes' upsert ON CONFLICT (role_id, user_id) had no constraint to
-- use and every policy change failed, and two global rows would make reads ambiguous. The admin
-- path now updates the scope's row or creates it (platform/auth/password-policy.ts
-- saveGlobalPasswordPolicy); this index guarantees there is at most one row per scope.
--
-- NULLS NOT DISTINCT (Postgres 15+) so the global scope, where both columns are null, is unique
-- too. Any duplicates are removed first, keeping the most recently updated row per scope.

DELETE FROM password_policy p
USING password_policy q
WHERE p.role_id IS NOT DISTINCT FROM q.role_id
  AND p.user_id IS NOT DISTINCT FROM q.user_id
  AND (p.updated_at, p.id) < (q.updated_at, q.id);

CREATE UNIQUE INDEX IF NOT EXISTS password_policy_scope_unique
  ON password_policy (role_id, user_id) NULLS NOT DISTINCT;

insert into applied_migrations (filename, confidence, note)
values (
  '042_password_policy_scope_unique.sql',
  'verified',
  'Sprint 7X: at most one password_policy row per scope (role_id, user_id, nulls not distinct); duplicates removed keeping the newest.'
)
on conflict (filename) do nothing;
