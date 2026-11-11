-- 066_recorded_notes.sql — the platform's notes on a record are a catalog key and its values, not
-- English written by SQL (TASK-208, N-110)
--
-- The platform wrote its own notes into rows as English, and every reader saw them in English
-- whatever its locale: a withdrawn approval's decision note ('Approved by <who> at <when>, never
-- run; withdrawn: <why>', and its undecided form), migration 046's two decision notes, the note
-- left where one about an erased account was ('erased with the account it was about', on a
-- proposal and in a run's step), an abandoned run's reason ('no activity and no open hold since
-- <when>') and a carried-over ban's reason ('A ban on this address carried over to a new
-- account.'). Now the row keeps the message's key and values (platform/errors/recorded-text.ts:
-- {"key": "screens.records.…", "params": {…}}), and the subject's data export renders them from
-- the catalog in the requester's locale. What a person wrote stays theirs, as written.
--
-- 1. proposals.decision_shown: jsonb, nullable — the platform's record of how a decision ended (a
--    withdrawal's: who had approved it and when); decision_note keeps only the note given (why).
-- 2. users.ban_note: jsonb, nullable — the platform's note on a ban (one carried over to the
--    account's address); ban_reason keeps only what a person wrote.
--    Each with a check: when set, an object whose "key" is a screen message (`screens.…`) and
--    whose "params", if any, is an object.
-- 3. Rows written before are migrated, matched exactly (anchored patterns; the free text a person
--    wrote, after "withdrawn: ", is kept as written in decision_note):
--    - proposals whose decision_note is a withdrawal's composed note, 'erased with the account it
--      was about', or one of 046's two notes;
--    - users whose ban_reason is the carried-over ban's text;
--    - agent_trajectories whose steps hold a held action's note copied from such a decision
--      (gating.ts endHeldTrajectory: output.note), the erased note's placeholder, or an
--      abandoned run's reason (action 'trajectory-abandoned': output.reason).
--    A note that does not match exactly (a person's) is left as it is. Rows already migrated (a
--    note set) are not read again.
--
-- Idempotent: `add column if not exists`, each check added only when absent, each update only on
-- rows not yet migrated (a second run matches none and writes nothing), the record upserted. The
-- helper functions are pg_temp's: gone with the session, nothing left in the schema.
-- Locks: proposals, users and agent_trajectories ACCESS EXCLUSIVE briefly while each column (no
-- default: no rewrite) and check (validated against its rows) are added, then the matching rows
-- updated (agent_trajectories read once, with a text prefilter). lock_timeout 5 s: on a busy
-- table it fails rather than queueing others behind it; run it again. Apply it as ONE run.

set local lock_timeout = '5s';

-- ── 1, 2. The columns ────────────────────────────────────────────────────────────────────────
alter table public.proposals add column if not exists decision_shown jsonb;
alter table public.users add column if not exists ban_note jsonb;

comment on column public.proposals.decision_shown is
  'The platform''s record of how a decision ended, as a screen message''s key and values ({"key": "screens.records.…", "params": {…}}): a withdrawn approval''s (who had approved it and when), rendered with decision_note (why) in the reader''s locale (platform/errors/recorded-text.ts). Null when the platform keeps none. TASK-208.';
comment on column public.users.ban_note is
  'The platform''s note on the account''s ban, as a screen message''s key and values (screens.records.ban_carried_over: a ban on its address carried over to it), rendered in the reader''s locale. ban_reason is what a person wrote. Null when there is none. TASK-208.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'proposals_decision_shown_shown'
       and conrelid = 'public.proposals'::regclass
  ) then
    alter table public.proposals add constraint proposals_decision_shown_shown check (
      decision_shown is null
      or (jsonb_typeof(decision_shown) = 'object'
          and jsonb_typeof(decision_shown -> 'key') = 'string'
          and (decision_shown ->> 'key') like 'screens.%'
          and (not decision_shown ? 'params'
               or jsonb_typeof(decision_shown -> 'params') = 'object'))
    );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'users_ban_note_shown'
       and conrelid = 'public.users'::regclass
  ) then
    alter table public.users add constraint users_ban_note_shown check (
      ban_note is null
      or (jsonb_typeof(ban_note) = 'object'
          and jsonb_typeof(ban_note -> 'key') = 'string'
          and (ban_note ->> 'key') like 'screens.%'
          and (not ban_note ? 'params' or jsonb_typeof(ban_note -> 'params') = 'object'))
    );
  end if;
end $$;

-- ── 3. Rows written before ───────────────────────────────────────────────────────────────────
-- A withdrawal's record from its composed note's parts: which form, who, when ('unknown' when it
-- was not recorded: the catalog's own word for it).
create or replace function pg_temp.m066_withdrawal(form text, approved_by text, approved_at text)
returns jsonb language sql immutable as $fn$
  select jsonb_build_object(
    'key', case when form = 'never run; withdrawn'
                then 'screens.records.withdrawn_after_approval'
                else 'screens.records.withdrawn_undecided' end,
    'params', jsonb_build_object(
      'approvedBy', case when approved_by = 'unknown'
                         then jsonb_build_object('key', 'screens.records.unknown')
                         else to_jsonb(approved_by) end,
      'approvedAt', case when approved_at = 'unknown'
                         then jsonb_build_object('key', 'screens.records.unknown')
                         else to_jsonb(approved_at) end))
$fn$;

-- The composed note's parts, anchored: who, when, which form, then the note as written.
create or replace function pg_temp.m066_parts(note text)
returns text[] language sql immutable as $fn$
  select regexp_match(note, '^Approved by (\S+) at (\S+), (never run; withdrawn|its run undecided; withdrawn, verified not applied): (.*)$')
$fn$;

-- One run step, migrated: a held action's note copied from a withdrawal (its record beside the
-- note as written), the erased note's placeholder, an abandoned run's reason. Any other step is
-- returned as it is.
create or replace function pg_temp.m066_step(step jsonb)
returns jsonb language plpgsql immutable as $fn$
declare
  o jsonb := step -> 'output';
  p text[];
begin
  if jsonb_typeof(o) is distinct from 'object' then
    return step;
  end if;
  if jsonb_typeof(o -> 'note') = 'string' then
    if o ->> 'note' = 'erased with the account it was about' then
      o := jsonb_set(o, '{note}', jsonb_build_object('key', 'screens.records.note_erased'));
    else
      p := pg_temp.m066_parts(o ->> 'note');
      if p is not null and not o ? 'decision' then
        o := o || jsonb_build_object('note', p[4], 'decision', pg_temp.m066_withdrawal(p[3], p[1], p[2]));
      end if;
    end if;
  end if;
  if step ->> 'action' = 'trajectory-abandoned' and jsonb_typeof(o -> 'reason') = 'string' then
    p := regexp_match(o ->> 'reason', '^no activity and no open hold since (\S+)$');
    if p is not null then
      o := jsonb_set(o, '{reason}', jsonb_build_object(
             'key', 'screens.records.trajectory_abandoned',
             'params', jsonb_build_object('since', p[1])));
    end if;
  end if;
  return jsonb_set(step, '{output}', o);
end
$fn$;

-- Proposals: a withdrawal's composed note.
update public.proposals p
   set decision_shown = pg_temp.m066_withdrawal(m.parts[3], m.parts[1], m.parts[2]),
       decision_note = m.parts[4]
  from (
    select tenant_id, id, pg_temp.m066_parts(decision_note) as parts
      from public.proposals
     where decision_shown is null
       and decision_note like 'Approved by %'
  ) m
 where p.tenant_id = m.tenant_id and p.id = m.id
   and m.parts is not null;

-- Proposals: the erased note's placeholder (it replaced the whole note).
update public.proposals
   set decision_shown = jsonb_build_object(
         'key', 'screens.records.note',
         'params', jsonb_build_object('note', jsonb_build_object('key', 'screens.records.note_erased'))),
       decision_note = null
 where decision_shown is null
   and decision_note = 'erased with the account it was about';

-- Proposals: migration 046's two notes.
update public.proposals
   set decision_shown = jsonb_build_object('key', case
         when decision_note = 'Superseded by migration 046: proposed before the proposing identity was recorded; propose again.'
         then 'screens.records.superseded_identity_unrecorded'
         else 'screens.records.superseded_newer_proposal' end),
       decision_note = null
 where decision_shown is null
   and decision_note in (
     'Superseded by migration 046: proposed before the proposing identity was recorded; propose again.',
     'Superseded by migration 046: another proposal for this operation is newer.');

-- Users: a carried-over ban's reason.
update public.users
   set ban_note = jsonb_build_object('key', 'screens.records.ban_carried_over'),
       ban_reason = null
 where ban_note is null
   and ban_reason = 'A ban on this address carried over to a new account.';

-- Runs: their steps' notes and reasons (only rows a step of which changes are written).
update public.agent_trajectories a
   set steps = m.steps
  from (
    select t.tenant_id, t.id,
           (select jsonb_agg(pg_temp.m066_step(s.step) order by s.n)
              from jsonb_array_elements(t.steps) with ordinality as s(step, n)) as steps
      from public.agent_trajectories t
     where jsonb_typeof(t.steps) = 'array'
       and jsonb_array_length(t.steps) > 0
       and t.steps::text like any (array[
             '%Approved by %', '%erased with the account it was about%',
             '%no activity and no open hold since %'])
  ) m
 where a.tenant_id = m.tenant_id and a.id = m.id
   and a.steps is distinct from m.steps;

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '066_recorded_notes.sql',
  'verified',
  'TASK-208: the platform''s notes on a record (a withdrawal''s decision note, 046''s notes, an erased note, an abandoned run''s reason, a carried-over ban) are a catalog key and values in proposals.decision_shown, users.ban_note and run steps; rows written before are migrated (N-110).',
  'sha256:79e385d3fb8833190f8e8e6a6a3c610d60348191959483c0bfcfbecead59e18e'
)
on conflict (filename) do update set checksum = excluded.checksum;
