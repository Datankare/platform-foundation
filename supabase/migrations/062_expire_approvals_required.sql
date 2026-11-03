-- 062_expire_approvals_required.sql — config.expire-approvals cannot be turned off (TASK-194,
-- the S1 sweep's rounds 18–20)
--
-- The approval-expiry job is the only thing that settles an approved change whose outcome is
-- being checked (a lost commit: marked undecided, or a configuration approval marked applied or
-- reopened) and that reminds of undecided runs waiting for a person. Turned off, nothing did, and
-- a setting's key stayed blocked. The job is now required (platform/jobs/duties.ts: its schedule's
-- `required`): the scheduler ignores its enabled setting, and every config write refuses to set
-- it off or to give a tenant its own value of it — the Jobs screen and
-- PATCH /api/operator/jobs/schedules/[kind], the config page, an operator's tenant settings, the
-- config assistant, a held change's approval and an approved two-person change's apply
-- (jobs.schedule_required, 409; platform/jobs/required-schedule.ts). Its interval stays an
-- operator's, within its bounds.
--
-- This puts the rows right, as the code reads them:
--   1. the setting back on;
--   2. every tenant's override of it deleted;
--   3. every two-person approval still pending for it withdrawn by the system, whatever value it
--      asked for (status rejected, no reviewer, the note below — the code's own wording,
--      platform/jobs/required-schedule.ts requiredJobWithdrawalNote, naming this migration), each
--      audited approval_withdrawn, reason refused, in the log of the tenant that filed it. Every
--      approval the code files carries its tenant — a shared deployment's platform-default one,
--      the operator's; a row with none (made by hand) is withdrawn with the note, without an audit
--      record, as no tenant's log is its. One approved and not yet applied is left to the job,
--      which marks it applied or reopens it; approving it again is refused and withdraws it. A
--      runtime hold of such a change (dual control) is withdrawn by the code when approved.
--
-- Idempotent: the update sets what is already set on a re-run, the delete and the withdrawal find
-- nothing, and the record is inserted once. One row of platform_config, and the overrides and
-- approvals of one key. Locks: ROW EXCLUSIVE on five tables — platform_config,
-- tenant_config_overrides, config_pending_approvals, audit_log and applied_migrations (no
-- rewrite, no DDL) — then row locks on the rows it changes only: the one platform_config row, the
-- key's overrides and its pending approvals. The audit records' foreign key to tenants takes ROW
-- SHARE on tenants and FOR KEY SHARE on each tenant row it names (the tenants of the approvals it
-- withdraws) — a tenant's deletion or key change waits; nothing else on tenants does.
-- lock_timeout 5s: on a busy table it fails rather than queueing others behind it; run it again.
-- Apply it as ONE run — the SQL Editor runs a pasted script as one transaction; psql needs
-- --single-transaction — so the record is written in the same transaction as the changes and a
-- failed run leaves neither. Transactional statements only.

set local lock_timeout = '5s';

update public.platform_config
   set value = 'true'::jsonb,
       description = 'Required — cannot be turned off (TASK-194): expires stale configuration approvals, settles approvals whose outcome is being checked, and lists undecided runs for a person. Only its interval may be changed.'
 where key = 'jobs.config.expire-approvals.enabled';

delete from public.tenant_config_overrides
 where key = 'jobs.config.expire-approvals.enabled';

with withdrawn as (
  update public.config_pending_approvals
     set status = 'rejected',
         reviewed_by = null,
         reviewed_at = now(),
         review_comment = 'withdrawn by the system: "jobs.config.expire-approvals.enabled" turns on a job that is now required — always on, and set only as the platform default (migration 062)'
   where config_key = 'jobs.config.expire-approvals.enabled'
     and status = 'pending'
  returning id, tenant_id, scope
)
insert into public.audit_log (tenant_id, action, details)
select w.tenant_id, 'admin_action'::audit_action,
       jsonb_build_object('type', 'approval_withdrawn', 'reason', 'refused',
                          'source', 'config-approval', 'holdIds', jsonb_build_array(w.id),
                          'key', 'jobs.config.expire-approvals.enabled', 'scope', w.scope,
                          'agent', 'migration:062_expire_approvals_required',
                          'outcome', 'succeeded')
  from withdrawn w
 where w.tenant_id is not null;

insert into public.applied_migrations (filename, confidence, note)
values (
  '062_expire_approvals_required.sql',
  'verified',
  'jobs.config.expire-approvals.enabled set on, its tenant overrides deleted and its pending approvals withdrawn: the approval-expiry job is required (TASK-194 rounds 18–20).'
)
on conflict (filename) do nothing;
