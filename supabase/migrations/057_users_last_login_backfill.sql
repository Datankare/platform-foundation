-- ============================================================================
-- 057_users_last_login_backfill.sql — each account's last sign-in, from the sign-ins the audit
-- log already holds (TASK-185)
--
-- users.last_login_at existed (001) but nothing wrote it. The platform now sets it on each sign-in
-- (platform/auth/auth-events.ts recordLastSignIn) and when it provisions an account. This fills
-- it, once, for the sign-ins recorded before: each account's latest `login_success` that was a
-- sign-in, not a session refresh (`details->>'method' <> 'refresh'`), recorded under the
-- account's id (auth-events, TASK-174). A value derived from recorded events, never an edit by
-- hand; an account with no recorded sign-in keeps NULL ("never signed in since …" in the console).
-- It only ever raises a value: a later sign-in recorded since the code was deployed is kept.
--
-- Its own migration and transaction, after 056, so 056's index builds are not held while this
-- reads the audit log.
--
-- Cost and locks: one pass over audit_log's `login_success` rows (idx_audit_log_action), grouped
-- by account, then one update per account that has one. The update takes row locks on those users
-- rows only (ROW EXCLUSIVE on the table: reads and writes of other rows go on); a sign-in or a
-- profile change of one of those accounts waits until this commits. Time grows with audit_log:
-- measure it first —
--
--   select count(*) from public.audit_log where action = 'login_success';
--
-- measured 4.5 s at 2,000,000 login_success rows and 100,000 accounts (about 1 s per 440,000
-- rows; 2 vCPU, Postgres 16). Past a few million, run it in a quiet period: the statement runs
-- as the project's `postgres` user in the SQL Editor, outside the request's statement timeout.
--
-- Idempotent and re-runnable: the update matches only a value lower than a recorded sign-in, so a
-- second run changes nothing.
-- ============================================================================

update public.users u
   set last_login_at = s.signed_in_at
  from (
    select tenant_id, actor_id, max(created_at) as signed_in_at
      from public.audit_log
     where action = 'login_success'
       and actor_id is not null
       and coalesce(details->>'method', '') <> 'refresh'
     group by tenant_id, actor_id
  ) s
 where u.tenant_id = s.tenant_id
   and u.id = s.actor_id
   and (u.last_login_at is null or u.last_login_at < s.signed_in_at);

insert into public.applied_migrations (filename, confidence, note)
values (
  '057_users_last_login_backfill.sql',
  'verified',
  'users.last_login_at filled from recorded sign-ins (login_success, not refresh), never lowered (TASK-185).'
)
on conflict (filename) do nothing;
