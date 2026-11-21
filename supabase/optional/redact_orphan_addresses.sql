-- OPTIONAL — operator step: the addresses of accounts erased before v6.0.0 (review 8 L1)
-- ============================================================================
-- This file is DELIBERATELY OUTSIDE supabase/migrations/ and is NOT applied by the migration
-- sequence. Run it once, by hand, as the database owner, after 052 is applied
-- (docs/MIGRATION_v5_to_v6.md, "Accounts erased before v6.0.0"). Since migration 076 (TASK-230)
-- it reads and rewrites a trajectory's steps as rows of agent_trajectory_steps: run it after 076.
--
-- WHY
--   Since v6.0.0 the soft delete replaces an account's address with its id wherever a held
--   action or a run names the account by it (only whole JSON string values, review 8 H-C), so the
--   hard purge finds every mention by the id. An account soft-deleted by an earlier version had
--   its address nulled without that replacement, and nothing in the database records the address
--   (user_deletions.email_hash is kept only for a banned account, and only since 052), so the
--   purge cannot find those mentions: the address outlives the erasure.
--
-- WHAT IT DOES
--   Step 1 lists every address held as a whole JSON string — a value or an object key — in the
--   places an address can stand for an account (the columns of ADDRESS_REPLACEMENTS in
--   platform/auth/gdpr-deletion.ts) that is the address of no live account of its tenant. Review
--   the list: an address of a person who has an account you know of but that has not signed in
--   yet would also be listed — remove it from the redaction by adding it to the keep list in
--   step 2. An address inside free text (a note) is not listed or replaced (see
--   docs/MIGRATION_v5_to_v6.md, "What erasure does not reach").
--   Step 2 replaces each listed address, as a whole string only (value or key), with "erased" —
--   in its own tenant's rows, and nowhere else. It is idempotent: a second run finds nothing.
--
-- CHECK FIRST — whether there is anything to do (none means skip this file):
--   select tenant_id, count(*) from public.users where deleted_at is not null group by 1;

-- ── Step 1: list (read-only) ───────────────────────────────────────────────────────────────
-- @step list
with docs as (
  select tenant_id, payload as doc from public.proposals
  union all select tenant_id, effects from public.proposals
  union all select tenant_id, step from public.agent_trajectory_steps
  union all select tenant_id, details from public.audit_log
  union all select tenant_id, moderation_result from public.review_queue
  union all select tenant_id, explanation_chain from public.review_queue where explanation_chain is not null
  union all select tenant_id, state from public.app_sessions
),
strings as (
  -- Every string value, and every object key (review 9 L7: an address can be a key).
  select d.tenant_id, v
    from docs d
    cross join lateral jsonb_path_query(d.doc, 'strict $.**') as v
  union all
  select d.tenant_id, v
    from docs d
    cross join lateral jsonb_path_query(d.doc, 'strict $.** ? (@.type() == "object").keyvalue().key') as v
),
found as (
  select distinct s.tenant_id, lower(s.v #>> '{}') as address
    from strings s
   where jsonb_typeof(s.v) = 'string'
     and (s.v #>> '{}') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
)
select f.tenant_id, f.address
  from found f
 where not exists (
   select 1 from public.users u
    where u.tenant_id = f.tenant_id and u.deleted_at is null and lower(u.email) = f.address
 )
 order by 1, 2;

-- ── Step 2: redact ─────────────────────────────────────────────────────────────────────────
-- @step redact
do $$
declare
  -- Addresses from step 1 to keep (people with an account not yet provisioned), lower-case.
  keep constant text[] := array[]::text[];
  -- One tenant only (its id), or null for every tenant.
  only_tenant constant uuid := null;
  r record;
begin
  for r in
    with docs as (
      select tenant_id, payload as doc from public.proposals
      union all select tenant_id, effects from public.proposals
      union all select tenant_id, step from public.agent_trajectory_steps
      union all select tenant_id, details from public.audit_log
      union all select tenant_id, moderation_result from public.review_queue
      union all select tenant_id, explanation_chain from public.review_queue where explanation_chain is not null
      union all select tenant_id, state from public.app_sessions
    ),
    strings as (
      -- Every string value, and every object key (review 9 L7: an address can be a key).
      select d.tenant_id, v
        from docs d
        cross join lateral jsonb_path_query(d.doc, 'strict $.**') as v
      union all
      select d.tenant_id, v
        from docs d
        cross join lateral jsonb_path_query(d.doc, 'strict $.** ? (@.type() == "object").keyvalue().key') as v
    ),
    found as (
      select distinct s.tenant_id, lower(s.v #>> '{}') as address
        from strings s
       where jsonb_typeof(s.v) = 'string'
         and (s.v #>> '{}') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    )
    select f.tenant_id, f.address
      from found f
     where f.address <> all (keep)
       and (only_tenant is null or f.tenant_id = only_tenant)
       and not exists (
         select 1 from public.users u
          where u.tenant_id = f.tenant_id and u.deleted_at is null and lower(u.email) = f.address
       )
  loop
    update public.proposals
       set payload = public.jsonb_erase_address_text(payload, r.address, 'erased'),
           effects = public.jsonb_erase_address_text(effects, r.address, 'erased')
     where tenant_id = r.tenant_id
       and (public.jsonb_may_mention_text(payload, r.address)
            or public.jsonb_may_mention_text(effects, r.address));
    -- A trajectory's steps are rows (migration 076, TASK-230): their trajectories locked first, in
    -- key order — 076's step trigger refuses a rewrite whose trajectory another transaction holds.
    with hit as materialized (
      select s.tenant_id, s.trajectory_id, s.seq from public.agent_trajectory_steps s
       where s.tenant_id = r.tenant_id and public.jsonb_may_mention_text(s.step, r.address)),
    locked as materialized (
      select 1 from public.agent_trajectories a
       where (a.tenant_id, a.id) in (select h.tenant_id, h.trajectory_id from hit h)
       order by a.tenant_id, a.id for update)
    update public.agent_trajectory_steps s
       set step = public.jsonb_erase_address_text(s.step, r.address, 'erased')
      from hit h
     where (select count(*) from locked) >= 0
       and s.tenant_id = h.tenant_id and s.trajectory_id = h.trajectory_id and s.seq = h.seq
       and public.jsonb_may_mention_text(s.step, r.address);
    update public.audit_log
       set details = public.jsonb_erase_address_text(details, r.address, 'erased')
     where tenant_id = r.tenant_id and public.jsonb_may_mention_text(details, r.address);
    update public.review_queue
       set moderation_result = public.jsonb_erase_address_text(moderation_result, r.address, 'erased'),
           explanation_chain = public.jsonb_erase_address_text(explanation_chain, r.address, 'erased')
     where tenant_id = r.tenant_id
       and (public.jsonb_may_mention_text(moderation_result, r.address)
            or public.jsonb_may_mention_text(explanation_chain, r.address));
    update public.app_sessions
       set state = public.jsonb_erase_address_text(state, r.address, 'erased')
     where tenant_id = r.tenant_id and public.jsonb_may_mention_text(state, r.address);
    raise notice 'redacted % in tenant %', r.address, r.tenant_id;
  end loop;
end $$;
