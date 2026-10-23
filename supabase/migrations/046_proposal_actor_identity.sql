-- 046_proposal_actor_identity.sql — a held action keeps the whole identity that proposed it, and
-- its approval is used once
--
-- proposals stored only actor_id and actor_role, and the store read every row back as an agent
-- acting for nobody. Who the action was proposed FOR (onBehalfOf), what kind of actor proposed
-- it, its attested delegation and the sign-in session it came through were all lost on the
-- durable store — so a consumer could not check that a decision on a held action is made by its
-- owner, nor that the proposing session is not the one approving it, and a resume after approval
-- could not run as the actor that proposed (Playform v0.8.0 release review, PF v5.1.0).
--
-- actor_identity holds the full AgentIdentity as JSON. Rows written before this migration keep
-- it null; the store then reads them as before (an agent with no owner), which every ownership
-- check refuses — they fail closed, never open. Held actions still awaiting a decision without
-- an identity could therefore never be decided, so they are superseded here (the agent proposes
-- again). Idempotent and re-runnable: a second run supersedes only rows written since by code
-- older than v5.1.0.

alter table proposals add column if not exists actor_identity jsonb;

update proposals
set status = 'superseded',
    decided_by = 'migration-046',
    decided_at = now(),
    decision_note = 'Superseded by migration 046: proposed before the proposing identity was recorded; propose again.',
    updated_at = now()
where status = 'proposed'
  and actor_identity is null;

-- An approval is used once: the commit it releases claims it, approved -> executed, with a
-- conditional update (status = 'approved'), so concurrent resumes cannot run the step twice.
alter table proposals drop constraint if exists proposals_status_check;
alter table proposals add constraint proposals_status_check
  check (status in ('proposed', 'approved', 'rejected', 'superseded', 'executed'));

-- At most one proposal per operation that is open, approved or used (was: open only), so an
-- approved or used action is never proposed again. Rows that would break it — an operation that
-- was re-held while its approval sat unused, before v5.1.0 — keep their newest and supersede the
-- rest first.
update proposals p
set status = 'superseded',
    decided_by = coalesce(p.decided_by, 'migration-046'),
    decided_at = coalesce(p.decided_at, now()),
    decision_note = 'Superseded by migration 046: another proposal for this operation is newer.',
    updated_at = now()
from (
  select id,
         row_number() over (partition by operation_id order by created_at desc, id desc) as rn
  from proposals
  where status in ('proposed', 'approved', 'executed')
) ranked
where p.id = ranked.id
  and ranked.rn > 1;

drop index if exists idx_proposals_live;
create unique index if not exists idx_proposals_one_live
  on proposals (operation_id)
  where status in ('proposed', 'approved', 'executed');

comment on column proposals.actor_identity is
  'The full AgentIdentity that proposed the action (actorType, actorId, agentRole, onBehalfOf, delegation, sessionId). Null on rows from before migration 046.';

insert into applied_migrations (filename, confidence, note)
values (
  '046_proposal_actor_identity.sql',
  'verified',
  'PF v5.1.0: proposals.actor_identity — the full proposing identity (owner, delegation, session), so ownership and independence can be checked on the durable store; status executed — an approval is used once.'
)
on conflict (filename) do nothing;
