-- ============================================================================
-- 060_lifecycle_closure.sql — every state has a way out, and every erasure completes (TASK-193)
--
-- The October 2026 lifecycle and data-minimisation audits (classes B and A) found rows that lived
-- for ever because nothing ended them. This migration adds what the code's fixes record:
--
--   1. agent.trajectory.abandon_after_hours (24, 1–720, tenant-settable like retention_days): an
--      open trajectory with no activity for that long and no open hold on its chain is ended
--      `failed` by the agents.trajectory-retention job before it deletes (B-1, B-2, B-3, A-1). The
--      job's description is updated to say so. This is what closes the trajectories already left
--      `running` (the five command-bar ones on playform-dev) — through the app's own job.
--   2. coppa.consent_expiry_days (14, 1–90, operator-only): a child's account whose
--      parent's consent is pending or denied that long after its age was recorded is erased by
--      the gdpr.retention-purge job (B-10, COPPA §312.5(c)(1)).
--      It ships OFF: coppa.consent_expiry_enabled (false, operator-only) — turned on with the
--      parental-consent flow (a later batch), so no account waits on a consent nobody can give yet.
--   3. config_pending_approvals.applied_at: when an approved change was applied. Approve and apply
--      are two transactions; config.expire-approvals now finds an approval approved and never
--      marked applied, and marks it applied (its own change is in the history) or reopens it
--      (B-9). An approval already approved is marked applied here only where the history shows
--      exactly its change — key, scope, tenant, reviewer, the value replaced and the value written;
--      any other is left for the job's recovery, which reopens it.
--   4. user_deletions: purge_attempts, purge_retry_at, last_purge_error — a failing erasure is
--      retried with a growing interval and never holds the others back (B-7);
--      external_erasures — each store outside the database (the sign-in identity) erased, with
--      when and how often, retried until done (B-8, D-9); mentions_erased_at — the erased
--      account's mentions in other tenants' audit records erased (A-3). Existing erasures start
--      with none recorded, so the job deletes their identities and other-tenant mentions too.
--      identity_pool — the identity pool the account was proven present in, recorded at the
--      soft delete: a provider's "not found" counts as erased only in that pool (review rounds 1
--      and 2). Null (never proven, or an erasure from before this migration): such an erasure
--      whose identity is not found stays pending and alerted (gdpr.identity_pool_unverified)
--      until two operators attest it.
--   5. agent.workflow.abandon_after_days (30, 1–365, tenant-settable): a workflow's trajectory is
--      the user's to continue, and is ended by the reaper only past this (review round 1).
--   6. proposals.reminded_at: when an undecided run was last alerted — once when found, then at
--      most daily (review round 1).
--
-- Locks: ALTER TABLE ADD COLUMN with a constant default (no rewrite) on config_pending_approvals,
-- user_deletions and proposals — an ACCESS EXCLUSIVE lock held for the statement only, all small
-- tables; one update of the approved approvals; four platform_config rows inserted, one updated.
-- lock_timeout bounds the wait for each lock: run it again if it times out.
--
-- Idempotent: every column is added if not exists, the settings are inserted on conflict do
-- nothing (an operator's value stands on a re-run), the backfill touches only rows without a
-- value, and the description update matches only the old text.
-- ============================================================================

set local lock_timeout = '5s';

insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier, tenant_overridable)
values
  ('agent.trajectory.abandon_after_hours', '24', '24',
   'Hours an open agent trajectory (running, paused, awaiting retry, indeterminate) may go without activity, with no open hold on it, before the agents.trajectory-retention job ends it as failed. Retention then counts from its last activity.',
   'limits', 'number', '1', '720', 'standard', true),
  ('coppa.consent_expiry_days', '14', '14',
   'Days a child''s account may wait for a parent''s consent (pending or denied) after its age is recorded; then the gdpr.retention-purge job erases it (COPPA 312.5(c)(1)).',
   'coppa', 'number', '1', '90', 'safety', false),
  ('coppa.consent_expiry_enabled', 'false', 'false',
   'Whether the gdpr.retention-purge job erases a child''s account whose parent''s consent is pending or denied past coppa.consent_expiry_days. Off until the parental-consent flow ships.',
   'coppa', 'boolean', null, null, 'safety', false),
  ('agent.workflow.abandon_after_days', '30', '30',
   'Days a workflow''s open trajectory may go without activity, with no open hold on it, before the agents.trajectory-retention job ends it as failed. A workflow is the user''s to continue; other trajectories end after agent.trajectory.abandon_after_hours.',
   'limits', 'number', '1', '365', 'standard', true)
on conflict (key) do nothing;

update public.platform_config
   set description = 'Ends open agent trajectories with no activity for agent.trajectory.abandon_after_hours and no open hold, then deletes completed and failed ones older than agent.trajectory.retention_days, for every active tenant and every suspended one (storage limitation does not pause).'
 where key = 'jobs.agents.trajectory-retention.enabled'
   and description = 'Deletes completed and failed agent trajectories older than agent.trajectory.retention_days, for every active tenant and every suspended one (storage limitation does not pause).';

alter table public.config_pending_approvals
  add column if not exists applied_at timestamptz;
comment on column public.config_pending_approvals.applied_at is
  'When an approved change was applied (TASK-193). Approved and null past its lease: config.expire-approvals marks it applied from its history, or reopens it.';
-- Only where the change's own history record shows it applied (review round 1): the same key,
-- scope and tenant, by the reviewer, after the approval, from the value it replaced to the value
-- approved. Any other approved row is left for config.expire-approvals' recovery, which reopens it.
update public.config_pending_approvals a
   set applied_at = (select min(h.created_at) from public.platform_config_history h
                      where h.config_key = a.config_key
                        and h.changed_by = a.reviewed_by
                        and h.created_at >= a.reviewed_at
                        and h.tenant_id is not distinct from a.tenant_id
                        and h.scope = case when a.action = 'reset' then 'tenant' else a.scope end
                        and coalesce(h.new_value, 'null'::jsonb) = coalesce(a.proposed_value, 'null'::jsonb)
                        and coalesce(h.previous_value, 'null'::jsonb) = coalesce(a.current_value, 'null'::jsonb))
 where a.status = 'approved' and a.applied_at is null
   and exists (select 1 from public.platform_config_history h
                where h.config_key = a.config_key
                  and h.changed_by = a.reviewed_by
                  and h.created_at >= a.reviewed_at
                  and h.tenant_id is not distinct from a.tenant_id
                  and h.scope = case when a.action = 'reset' then 'tenant' else a.scope end
                  and coalesce(h.new_value, 'null'::jsonb) = coalesce(a.proposed_value, 'null'::jsonb)
                  and coalesce(h.previous_value, 'null'::jsonb) = coalesce(a.current_value, 'null'::jsonb));

alter table public.user_deletions
  add column if not exists purge_attempts integer not null default 0,
  add column if not exists purge_retry_at timestamptz,
  add column if not exists last_purge_error text,
  add column if not exists external_erasures jsonb not null default '{}'::jsonb,
  add column if not exists mentions_erased_at timestamptz,
  add column if not exists identity_pool text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_deletions_last_purge_error_len') then
    alter table public.user_deletions
      add constraint user_deletions_last_purge_error_len
      check (last_purge_error is null or char_length(last_purge_error) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_deletions_external_erasures_object') then
    alter table public.user_deletions
      add constraint user_deletions_external_erasures_object
      check (jsonb_typeof(external_erasures) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_deletions_identity_pool_len') then
    alter table public.user_deletions
      add constraint user_deletions_identity_pool_len
      check (identity_pool is null or char_length(identity_pool) <= 200);
  end if;
end $$;
comment on column public.user_deletions.purge_attempts is
  'Failed purges so far (TASK-193); the next is not before purge_retry_at (1 h, doubling, at most 7 days).';
comment on column public.user_deletions.last_purge_error is
  'The names of the steps the last failed purge could not complete — never their messages.';
comment on column public.user_deletions.external_erasures is
  'Each store outside the database the erasure reached, by name: {doneAt} or {attempts, error, retryAt} (platform/gdpr/external-erasure.ts).';
comment on column public.user_deletions.mentions_erased_at is
  'When the account''s mentions in other tenants'' audit records were erased (TASK-193, A-3).';
comment on column public.user_deletions.identity_pool is
  'The identity pool the account was proven present in (recorded at the soft delete): a "not found" counts as erased only there. Null: never proven — closed only by two operators'' attestation.';

alter table public.proposals
  add column if not exists reminded_at timestamptz;
comment on column public.proposals.reminded_at is
  'When an undecided run (indeterminate) was last alerted: once when found, then at most daily (TASK-193).';

insert into public.applied_migrations (filename, confidence, note)
values (
  '060_lifecycle_closure.sql',
  'verified',
  'agent.trajectory.abandon_after_hours, agent.workflow.abandon_after_days, coppa.consent_expiry_days and coppa.consent_expiry_enabled (off) seeded; config_pending_approvals.applied_at (approved rows whose change is in the history backfilled); user_deletions purge retry, external-erasure, identity-pool and cross-tenant columns; proposals.reminded_at (TASK-193).'
)
on conflict (filename) do nothing;
