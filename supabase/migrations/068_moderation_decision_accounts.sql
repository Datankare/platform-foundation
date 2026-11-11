-- 068_moderation_decision_accounts.sql — a moderation decision names the account whose content it
-- judged (TASK-210, N-117)
--
-- The Guardian recorded every decision in content_safety_audit without its account: the audit
-- record was built from the result alone (platform/moderation/audit.ts), and the screening
-- context's user id was never passed to it — so user_id was null on every row. An appeal's
-- ownership check (POST /api/moderation/appeals: the decision's account must be the appellant's)
-- therefore refused every appeal, no account could see its decisions, and an account's export and
-- erasure (platform/auth/user-data.ts, by user_id) never reached them. The code now records the
-- account; this migration gives the rows written before theirs, where the platform recorded it
-- elsewhere, unambiguously:
--
-- 1. user_strikes: the strike the Sentinel gave for a decision names it (guardian_decision_id) and
--    the account (user_id).
-- 2. review_queue: an escalation or a ban review names the decision (moderation_result's
--    trajectoryId) and the account whose content it was (target_user_id). An appeal is not read:
--    none could be filed (the check above refused them).
--
-- A decision is given an account only when every such record in its tenant names the same one,
-- and that account exists and is not erased (an erased account's decisions were detached by its
-- erasure, `user_id = null`: they stay detached). A decision no record names — one the Sentinel
-- did not attribute (attributeToUser false), or a guest's — stays without an account: the
-- platform never recorded whose it was.
--
-- Idempotent: only rows with no account are updated (a second run matches none). No schema
-- change. Locks: content_safety_audit ROW EXCLUSIVE while the matching rows are updated (it holds
-- a row per screening: one pass, joined on trajectory_id, which is indexed). lock_timeout 5 s: on
-- a busy table it fails rather than queueing others behind it; run it again. Apply it as ONE run.

set local lock_timeout = '5s';

with named as (
  select s.tenant_id, s.guardian_decision_id as trajectory_id, s.user_id::text as user_id
    from public.user_strikes s
   where s.guardian_decision_id is not null
  union
  select q.tenant_id, q.moderation_result ->> 'trajectoryId', q.target_user_id::text
    from public.review_queue q
   where q.source in ('escalation', 'ban_review')
     and q.moderation_result ->> 'trajectoryId' is not null
),
one_account as (
  select n.tenant_id, n.trajectory_id, min(n.user_id) as user_id
    from named n
   group by n.tenant_id, n.trajectory_id
  having count(distinct n.user_id) = 1
)
update public.content_safety_audit a
   set user_id = o.user_id
  from one_account o
 where a.user_id is null
   and a.tenant_id = o.tenant_id
   and a.trajectory_id = o.trajectory_id
   and exists (
     select 1 from public.users u
      where u.tenant_id = o.tenant_id and u.id::text = o.user_id and u.deleted_at is null);

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '068_moderation_decision_accounts.sql',
  'verified',
  'TASK-210: a moderation decision recorded before names the account its strike or review case names (content_safety_audit.user_id was never written), so it can be listed, appealed, exported and erased (N-117).',
  'sha256:75d5d315b745e38f90e91cbd03fee4b23b1432b681a1e444cc7f18b7f685df6b'
)
on conflict (filename) do update set checksum = excluded.checksum;
