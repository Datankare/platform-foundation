-- ============================================================================
-- 054_user_deletions_subject.sql — an erasure remembers the identity it closed (TASK-174)
--
-- An erased account is never provisioned again: its user_deletions record outlives it, and
-- provisioning refuses an identity whose account was erased (audit A-11). The record was found
-- by user_id alone, which is the identity's subject only while `users.id = users.cognito_sub`.
-- An account re-linked to a new identity pool (scripts/relink-identity.mjs, ADR-012 amendment)
-- keeps its id and gets a new subject: once its row is purged, its subject would no longer name
-- an erased account, and a sign-in with it would create a fresh one.
--
-- So the record keeps the subject too (user_deletions.cognito_sub, written by the soft delete),
-- and provisioning refuses an identity found by either. Rows recorded before this keep working
-- by user_id — no account was re-linked before this release — and a row whose account is still
-- in place (soft-deleted, not yet purged) is given its subject here.
--
-- Idempotent and re-runnable: the column and index are added once; the backfill fills only
-- empty values, so a second run changes nothing.
-- ============================================================================

alter table public.user_deletions add column if not exists cognito_sub text;

comment on column public.user_deletions.cognito_sub is
  'The identity-provider subject of the erased account (users.cognito_sub at the soft delete): provisioning refuses it as it refuses user_id — they differ for an account re-linked to a new identity pool (migration 054, TASK-174).';

create index if not exists user_deletions_cognito_sub_idx
  on public.user_deletions (tenant_id, cognito_sub)
  where cognito_sub is not null;

update public.user_deletions d
   set cognito_sub = u.cognito_sub
  from public.users u
 where u.tenant_id = d.tenant_id
   and u.id = d.user_id
   and u.cognito_sub is not null
   and d.cognito_sub is null;

insert into public.applied_migrations (filename, confidence, note)
values (
  '054_user_deletions_subject.sql',
  'verified',
  'user_deletions.cognito_sub: an erasure remembers the identity it closed, so an account re-linked to a new identity pool is never provisioned again once purged (TASK-174).'
)
on conflict (filename) do nothing;
