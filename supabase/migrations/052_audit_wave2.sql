-- 052_audit_wave2.sql — the October 2026 audit, Wave 2 (Sprint 7X; register docs/audits/2026-10-REGISTER.md)
--
--   * audit_action 'logout' — sign-outs are recorded with the other authentication events (A-12).
--   * user_deletions.standing, .email_hash, .email_hash_key, .email_hash_scheme — an account erased
--     while banned keeps its ban: the address is kept only as a keyed hash (HMAC-SHA256 under
--     ERASURE_HASH_KEY, review 7 L4; the key's id beside it, so keys rotate, review 8 L6; how it
--     was made, recorded, review 9 M6), and
--     a new identity with that address starts banned
--     (A-11). Nothing else of the account is kept.
--   * auth.staff_mfa_required — staff sign in with a second factor (A-9); safety tier,
--     operator-only, under dual control (seeded once).
--   * auth.token_cache_seconds, auth.token_stale_grace_seconds — how long a verified access token
--     is answered from the shared cache, and how far an ordinary route may stand on it while the
--     identity provider cannot answer (platform/auth/token-verification.ts). Safety tier.
--   * config.dual_control_keys gains every setting whose change is a change of power (review 8 M2,
--     listed below), each key once (config_dual_control_seeded, review 13 L4: a key added to the
--     list later reaches a database that ran an earlier 052; an operator's removal stands).
--   * admin.dual_control_actions — the command-bar actions held for a second admin (X-10, C-14):
--     changes to roles and their permissions, a user's role, entitlement groups (created, turned
--     on or off; review 7 M6), the approval policy. Safety tier, operator-only, itself under dual
--     control (seeded once). Never an action whose effect is a config write — what a capability
--     maps to, agents' registration and scope: the keys they write (agent.capability_features,
--     agent.trusted_agents) are dual-controlled, and that is their one hold, under the key's
--     rules (review 10 H1, H3: holding the action as well let an action-level approval stand in
--     for the key's).
--   * proposals: status 'executing' and last_run_error — an approval is claimed for its run and
--     kept when the run fails before taking effect (review 10 H2); run_token, run_atomic and
--     status 'indeterminate' — a claim's generation, and a run whose outcome is unknown waits for
--     a human (review 11 H-1).
--   * agent_trajectories.segment, previous_trajectory_id, step_offset — a trajectory that reached
--     its cap is continued in a linked new one (review 11 H-2).
--   * agent_trajectories.chain_root_id and the chain guard trigger — every append goes to the
--     chain's tail, and a chain can be neither cyclic, forked, cross-tenant nor misnumbered
--     (review 12 M1, L6); agent.trajectory_max_segments bounds a chain (review 12 M2; safety tier,
--     operator-only, under dual control — seeded once).
--   * stream — /api/stream's feature was in neither governed list, so the account-status guard
--     refused it to every user and the consent gate never applied to it; it is added to
--     account_status.known_features and coppa.blocked_features (X-16), once.
--   * jsonb_replace_text_value(doc, target, replacement) — an erased account's address is replaced
--     in held actions and runs only where a whole JSON string — a value or a key — equals it
--     (review 8 H-C, review 9 L7); non-recursive, linear, and it cannot fail on any document
--     (review 9 H2). jsonb_may_mention_text(doc, target) is its cheap pre-filter.
--   * moderation.blocklist_only_surfaces is retired: a dual-controlled setting nothing read (D-20).
--     Honouring it would let a surface skip the classifier; nothing needs that, so it is retired
--     rather than left to mislead: the row is kept, marked category 'retired' (the platform
--     neither lists it nor lets it be set), its pending approvals expire, and it leaves
--     config.dual_control_keys. Deleting the row would have cascaded away its change history and
--     approvals — the record of who changed a safety setting and when (review 7 L2).
--   * deletion_manifest named tables dropped long ago (players, player_devices,
--     player_entitlements) and none of the tables that hold users' data now (E-7). Those three
--     names — the platform's own, retired by 008 — are removed from every row where no such
--     table exists, by an exact lookup in pg_class (a name an app recreated stays), and a row left
--     naming nothing is removed. Nothing else is touched: an app module's row naming a table a
--     later app migration creates stays (review 7 L2: the earlier `to_regclass('public.' || name)`
--     removed such rows, misjudged a quoted mixed-case name, and aborted on a schema-qualified
--     one). The platform's register (platform/auth/user-data.ts) is recorded as the `platform`
--     module (once).
--
-- Idempotent and lock-light: new nullable columns (no rewrite), a partial index on a table that
-- holds one row per erased account, configuration inserted on conflict do nothing, and the list
-- changes made on this migration's first application only — an operator's later choice stands
-- on a re-run (scripts/migration-replay.sh applies it twice and compares).

-- ── Authentication events (A-12) ────────────────────────────────────────────────────────────
alter type public.audit_action add value if not exists 'logout';

-- ── Ban evasion through erasure (A-11) ──────────────────────────────────────────────────────
alter table public.user_deletions
  add column if not exists standing text,
  add column if not exists email_hash text,
  -- Which key of the erasure-hash key ring made email_hash (review 8 L6): the key's id, or null
  -- for a form a pre-release build wrote without one.
  add column if not exists email_hash_key text,
  -- How email_hash was made (review 9 M6), recorded — never guessed from a null key id:
  -- 'hmac-of-sha256' (this release: HMAC under the key of the address's SHA-256), 'sha256' (a
  -- pre-release build's unkeyed form, which the retention job upgrades), 'hmac' (the review 7
  -- pre-release build's HMAC of the address, rehashed only when the address signs up again).
  add column if not exists email_hash_scheme text;

-- A key id is written only by this release's writer, so it identifies the scheme. A row without
-- one is left unmarked: it is never upgraded (no environment ran a pre-release build — see
-- docs/MIGRATION_v5_to_v6.md step 2.6 — and a guess would turn a ban into a hash that matches
-- nothing), and it is still matched, by every form, when the address signs up again.
update public.user_deletions
   set email_hash_scheme = 'hmac-of-sha256'
 where email_hash is not null and email_hash_key is not null and email_hash_scheme is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.user_deletions'::regclass
       and conname = 'user_deletions_standing_known'
  ) then
    alter table public.user_deletions
      add constraint user_deletions_standing_known
      check (standing is null or standing in ('active', 'warned', 'restricted', 'suspended', 'banned'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.user_deletions'::regclass
       and conname = 'user_deletions_email_hash_key_shape'
  ) then
    alter table public.user_deletions
      add constraint user_deletions_email_hash_key_shape
      check (email_hash_key is null or email_hash_key ~ '^[0-9a-f]{16}$');
  end if;
  -- A known scheme; a key id only with the keyed scheme this release writes. Written so that no
  -- part can be NULL (review 10 L12: `email_hash_scheme = 'hmac-of-sha256'` was NULL for a key id
  -- with no scheme, and a CHECK passes on NULL). A database that ran a pre-release form of this
  -- migration gets this one: the constraint is replaced when it is not this form — recognised by
  -- its comment — and never otherwise (review 11 L-6: it was dropped and re-added, with a full
  -- scan under an exclusive lock, on every application). Added NOT VALID (a brief lock, no scan),
  -- then validated (a scan that blocks no reads or writes).
  if coalesce(
       (select obj_description(c.oid, 'pg_constraint')
          from pg_constraint c
         where c.conrelid = 'public.user_deletions'::regclass
           and c.conname = 'user_deletions_email_hash_scheme_known'),
       '') <> 'review 10 L12: no NULL-valued part' then
    alter table public.user_deletions
      drop constraint if exists user_deletions_email_hash_scheme_known;
    alter table public.user_deletions
      add constraint user_deletions_email_hash_scheme_known
      check ((email_hash_scheme is null
              or email_hash_scheme in ('hmac-of-sha256', 'sha256', 'hmac'))
             and (email_hash_key is null
                  or (email_hash_scheme is not null and email_hash_scheme = 'hmac-of-sha256')))
      not valid;
    alter table public.user_deletions
      validate constraint user_deletions_email_hash_scheme_known;
    comment on constraint user_deletions_email_hash_scheme_known on public.user_deletions
      is 'review 10 L12: no NULL-valued part';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.user_deletions'::regclass
       and conname = 'user_deletions_email_hash_shape'
  ) then
    alter table public.user_deletions
      add constraint user_deletions_email_hash_shape
      check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create index if not exists user_deletions_banned_hash_idx
  on public.user_deletions (tenant_id, email_hash)
  where email_hash is not null and standing = 'banned';

-- ── An erased account's address, replaced exactly (review 8 H-C; review 9 H2, L7) ──────────────
-- At the soft delete the address in held actions and runs becomes the account's id, so the hard
-- purge finds every mention by the id. Only a complete JSON string equal to the address (ignoring
-- case) is replaced — a value or an object key (review 9 L7: {"invited":{"ann@…":"pending"}} kept
-- the address as a key) — anywhere in the document: a substring replace turned another account's
-- "joann@…" into "jo<id>" (ann@…'s erasure), and the purge then deleted that account's proposal.
-- An address inside a longer text (a note, a message) is free text: not found or replaced here.
--
-- Review 9 H2: the function was recursive, so a document nested ~520 deep exceeded the stack and
-- failed the whole erasure, and a 200 000-element document took 4.1 s. Now it never recurses and
-- cannot fail on any jsonb value: it works on the document's canonical text (jsonb's output, in
-- which raw control characters never occur — they are always escaped — so chr(1)…chr(4) are free
-- to use as markers), in linear time:
--
--   1. Every escaped backslash (\\) becomes chr(3), then every escaped quote (\") chr(4). Paired
--      left to right, this is exactly JSON's own reading (backslashes occur only inside strings,
--      and every remaining backslash starts an escape), so afterwards every " is a string's own
--      opening or closing quote, and a string is "[^"]*". The address is encoded the same way.
--   2. Fast path — the encoded address contains a character that never occurs in the text between
--      two strings (that text is only , : [ ] { } spaces, numbers, true/false/null; an e-mail
--      address always has @): every case-insensitive occurrence of "address" is then a complete
--      string, never the closing quote of one string, the text between, and the opening quote of
--      the next. One literal case-insensitive replace does it.
--      Full path — any other target: every string is marked chr(1)…chr(2) first, and only a whole
--      marked string equal to the address is replaced.
--   3. Unchanged: the document is returned as it was. Changed: the markers are undone and the text
--      read back as jsonb. A document as deep as the stack allows to exist (~18 000 levels when
--      built, ~30 000 when parsed, at the default 2 MB max_stack_depth) can be read back only if
--      this call has as much stack left as its writer had. If not, the type is never changed
--      (review 10 L7: it was kept as a JSON string, so an object became a string), and neither is
--      the content lost (review 11 L-2: the whole value — a whole audit record's details, a whole
--      run's steps — was replaced by a marker): an object becomes {"_redacted": "…", "text":
--      <the document's text, the address replaced>}, an array ["_redacted: …", <that text>] —
--      and a warning says so. Erasure never fails because of another row's document. (Stored documents are at most 64 deep since 052 — platform/errors/json-limits.ts
--      — so only a document stored before that can meet this.)
--   4. Keys kept (review 10 L8): replacing a key can collide with a key the object already has
--      ({"ann@x.com":"p","<id>":"q"}, or two spellings of the address), and reading back would keep
--      one value and drop the other. The keys are counted before and after the read-back; when one
--      was lost, the replacement is made again with every replaced key numbered in document order
--      — "<id>#1", "<id>#2", … — so no key collides and no value is lost; should the object already
--      hold such a key, "<id>#1-<digest of the document>" (a document cannot hold a key naming its
--      own digest).
--
-- Measured (Postgres 16, review 9): depth 10 000, 2.5 ms; a 1 000 000-element document (~40 MB of
-- text, 1 000 mentions), ~3 s (fast path); with no mention, ~1 s — the cost of reading the text.
-- The cost is linear in a row's text, and the rows it rewrites are bounded (review 10 L10): a
-- trajectory row holds at most 1 000 steps and 16 MiB (platform/errors/json-limits.ts), so its
-- rewrite takes at most ~1.5 s at that rate; every other stored document at most 1 MiB.
create or replace function public.jsonb_may_mention_text(doc jsonb, target text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  -- A cheap, sound pre-filter for jsonb_replace_text_value: false only when no string in doc can
  -- equal target (case-insensitively). The same literal case-insensitive match that function uses.
  select doc is not null and target is not null
     and doc::text ~* ('***=' || substr(to_jsonb(target)::text, 2, length(to_jsonb(target)::text) - 2));
$$;
revoke all on function public.jsonb_may_mention_text(jsonb, text) from public, anon, authenticated;
grant execute on function public.jsonb_may_mention_text(jsonb, text) to app_tenant;

create or replace function public.jsonb_replace_text_value(doc jsonb, target text, replacement text)
returns jsonb
language plpgsql
immutable
parallel unsafe
set search_path = pg_catalog
as $$
declare
  src text;
  enc text;
  rep text;
  work text;
  done text;
  out_text text;
  plain text;
  result jsonb;
  parts text[];
  suffix text;
  attempt int;
begin
  if doc is null or target is null then
    return doc;
  end if;
  src := doc::text;
  enc := to_jsonb(target)::text;
  -- Not even a substring, ignoring case: nothing to replace (the common case, one scan).
  if not (src ~* ('***=' || substr(enc, 2, length(enc) - 2))) then
    return doc;
  end if;
  rep := to_jsonb(coalesce(replacement, ''))::text;

  -- 1. Escapes out of the way: afterwards every " delimits a string.
  work := replace(replace(src, '\\', chr(3)), '\"', chr(4));
  enc := replace(replace(enc, '\\', chr(3)), '\"', chr(4));
  rep := replace(replace(rep, '\\', chr(3)), '\"', chr(4));
  plain := work;

  -- An ASCII character the text between strings never holds, in either case (it holds only
  -- , : [ ] { } spaces, digits . + - and the letters of true/false/null), or an escape.
  if substr(enc, 2, length(enc) - 2)
       ~ ('[!#$%&''()*/;<=>?@\\^_`|~bcdghijkmopqvwxyzBCDGHIJKMOPQVWXYZ' || chr(3) || chr(4) || ']') then
    -- 2a. Fast path: every occurrence is a whole string (see above).
    done := regexp_replace(work, '***=' || enc, rep, 'gi');
  else
    -- 2b. Full path: mark every string, replace a whole marked string only.
    work := regexp_replace(work, '"[^"]*"', chr(1) || '\&' || chr(2), 'g');
    done := regexp_replace(work, '***=' || chr(1) || enc || chr(2), chr(1) || rep || chr(2), 'gi');
    if done = work then
      return doc;
    end if;
    done := replace(replace(done, chr(1), ''), chr(2), '');
  end if;
  if done = work then
    return doc;
  end if;

  -- 3. Escapes back; read the text back as jsonb. Too deep to read back here: redacted to its
  -- own type, never turned into a string (review 10 L7).
  out_text := replace(replace(done, chr(4), '\"'), chr(3), '\\');
  begin
    result := out_text::jsonb;
  exception when others then
    raise warning 'jsonb_replace_text_value: document too deep to read back here (%); kept as its replaced text, in its type', sqlerrm;
    return case jsonb_typeof(doc)
             when 'object' then jsonb_build_object('_redacted', 'erasure: too deep to rewrite', 'text', out_text)
             when 'array' then jsonb_build_array('_redacted: erasure: too deep to rewrite', out_text)
             else to_jsonb(coalesce(replacement, ''))
           end;
  end;

  -- 4. Every key kept (review 10 L8): a key in the canonical text is a string followed by ": ".
  -- No replacement in a key's place, no collision (the common case, one scan).
  if position(rep || ': ' in done) = 0 then
    return result;
  end if;
  if regexp_count(done, '"[^"]*": ') =
     regexp_count(replace(replace(result::text, '\\', chr(3)), '\"', chr(4)), '"[^"]*": ') then
    return result;
  end if;
  -- A replaced key collided: replace again, numbering every replaced key in document order —
  -- "<id>#1", "<id>#2", … — and, should the object already hold such a key, "<id>#1-<digest>"
  -- with a digest of the document itself (a document cannot hold a key naming its own digest).
  work := regexp_replace(plain, '"[^"]*"', chr(1) || '\&' || chr(2), 'g');
  parts := regexp_split_to_array(work, '***=' || chr(1) || enc || chr(2) || ': ', 'i');
  for attempt in 1..2 loop
    suffix := case when attempt = 1 then '' else '-' || left(md5(src), 12) end;
    select string_agg(
             case when t.n = 1 then t.p
                  else chr(1) || substr(rep, 1, length(rep) - 1) || '#' || (t.n - 1)::text
                       || suffix || '"' || chr(2) || ': ' || t.p
             end, '' order by t.n)
      into done
      from unnest(parts) with ordinality as t(p, n);
    done := regexp_replace(done, '***=' || chr(1) || enc || chr(2), chr(1) || rep || chr(2), 'gi');
    done := replace(replace(done, chr(1), ''), chr(2), '');
    out_text := replace(replace(done, chr(4), '\"'), chr(3), '\\');
    begin
      result := out_text::jsonb;
    exception when others then
      raise warning 'jsonb_replace_text_value: document too deep to read back here (%); kept as its replaced text, in its type', sqlerrm;
      return case jsonb_typeof(doc)
               when 'object' then jsonb_build_object('_redacted', 'erasure: too deep to rewrite', 'text', out_text)
               when 'array' then jsonb_build_array('_redacted: erasure: too deep to rewrite', out_text)
               else to_jsonb(coalesce(replacement, ''))
             end;
    end;
    if regexp_count(done, '"[^"]*": ') =
       regexp_count(replace(replace(result::text, '\\', chr(3)), '\"', chr(4)), '"[^"]*": ') then
      return result;
    end if;
  end loop;
  raise warning 'jsonb_replace_text_value: a numbered key still collides; kept as its replaced text, in its type';
  return case jsonb_typeof(doc)
           when 'object' then jsonb_build_object('_redacted', 'erasure: key collision', 'text', out_text)
           else jsonb_build_array('_redacted: erasure: key collision', out_text)
         end;
end;
$$;
revoke all on function public.jsonb_replace_text_value(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.jsonb_replace_text_value(jsonb, text, text) to app_tenant;

-- ── An approval is claimed for its run, and kept when the run fails (review 10 H2) ──────────
-- 'executing': the approval in use by one run (approved -> executing, compare-and-set); the run
-- ends it executed, or approved again when it failed before taking effect (last_run_error says
-- why), so a transient failure no longer burns the approval. One live proposal per operation
-- counts an executing one too.
alter table public.proposals add column if not exists last_run_error text;
-- Review 11 H-1: each claim carries a token (its generation) that the run's completion and release
-- compare, so a run slower than its lease cannot end a claim it no longer holds; run_atomic says
-- the claim is one transaction with its effect. 'indeterminate': a run that did not end within its
-- lease and whose effect cannot be known — never returned to 'approved'; a human marks it
-- executed or approves it again (platform/admin/hold-expiry.ts, approval-decision.ts).
alter table public.proposals add column if not exists run_token uuid;
alter table public.proposals add column if not exists run_atomic boolean;
alter table public.proposals drop constraint if exists proposals_status_check;
alter table public.proposals add constraint proposals_status_check
  check (status in ('proposed', 'approved', 'executing', 'indeterminate', 'rejected', 'superseded', 'executed'));
drop index if exists public.idx_proposals_tenant_one_live;
create unique index if not exists idx_proposals_tenant_one_live
  on public.proposals (tenant_id, operation_id)
  where status = any (array['proposed'::text, 'approved'::text, 'executing'::text, 'indeterminate'::text, 'executed'::text]);
-- The recovery of a run that never ended (platform/admin/hold-expiry.ts recoverStaleRuns).
create index if not exists idx_proposals_executing
  on public.proposals (updated_at)
  where status = 'executing';
comment on column public.proposals.last_run_error is
  'Why the last run of this approval failed before taking effect (review 10 H2), or why its outcome is unknown (review 11 H-1).';
comment on column public.proposals.run_token is
  'The current claim''s token (review 11 H-1): only the run holding it may complete or release the claim.';

-- ── A trajectory that reached its cap is continued, linked (review 11 H-2) ──────────────────
-- A trajectory holds at most 1 000 steps / 16 MiB (review 10 L10), so an app session's 1 001st
-- move was refused. A full trajectory is now continued by a new one for the same subject, linked
-- to it (previous_trajectory_id, segment, step_offset — the steps its predecessors hold), in the
-- same transaction as the append. One continuation per segment (a unique index): never a fork.
-- New columns with constant defaults (no rewrite); the checks are added NOT VALID, then validated.
alter table public.agent_trajectories
  add column if not exists segment integer not null default 1,
  add column if not exists previous_trajectory_id uuid,
  add column if not exists step_offset integer not null default 0;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agent_trajectories'::regclass
       and conname = 'agent_trajectories_chain_shape'
  ) then
    alter table public.agent_trajectories
      add constraint agent_trajectories_chain_shape
      check (segment >= 1 and step_offset >= 0
             and (segment = 1) = (previous_trajectory_id is null))
      not valid;
    alter table public.agent_trajectories
      validate constraint agent_trajectories_chain_shape;
  end if;
end $$;
create unique index if not exists idx_trajectories_one_continuation
  on public.agent_trajectories (tenant_id, previous_trajectory_id)
  where previous_trajectory_id is not null;
comment on column public.agent_trajectories.previous_trajectory_id is
  'The trajectory this one continues (review 11 H-2): a run or session whose trajectory reached its cap goes on in a linked new one.';
comment on column public.agent_trajectories.segment is
  'Which segment of its chain this trajectory is (1: the first).';
comment on column public.agent_trajectories.step_offset is
  'Steps held by the earlier segments of its chain.';

-- ── The chain's shape is the database's to keep (review 12 M1, L6) ──────────────────────────
-- chain_root_id: the first segment of the chain a row belongs to — an append finds the chain's
-- tail from any segment by it (always the tail: a step never goes back into an earlier segment it
-- fits in). A trigger sets it on every insert and refuses a continuation whose predecessor is
-- missing, another tenant's, not one segment before it, or whose step_offset is not the steps
-- before it; the chain columns never change after insert; and a segment that has a continuation
-- keeps its step count (review 13 L3: neither grows nor shrinks; the insert locks the predecessor,
-- so a concurrent update of it is serialised with the continuation's insert, never interleaved). So no chain can be cyclic, forked, cross-tenant or misnumbered — a
-- hostile row is refused, not followed (a recovery walking a cyclic chain looped forever).
-- Backfilled by following the links from each first segment; a row whose chain cannot be traced
-- is its own root (the CHECK below still holds it to its shape).
alter table public.agent_trajectories
  add column if not exists chain_root_id uuid;
with recursive chain(id, root, depth) as (
  select t.id, t.id, 1 from public.agent_trajectories t
   where t.previous_trajectory_id is null and t.chain_root_id is null
  union
  select c.id, chain.root, chain.depth + 1
    from public.agent_trajectories c join chain on c.previous_trajectory_id = chain.id
   where chain.depth < 100000
)
update public.agent_trajectories t set chain_root_id = chain.root
  from chain where t.id = chain.id and t.chain_root_id is null;
update public.agent_trajectories set chain_root_id = id where chain_root_id is null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agent_trajectories'::regclass
       and conname = 'agent_trajectories_chain_root_set'
  ) then
    alter table public.agent_trajectories
      add constraint agent_trajectories_chain_root_set
      check (chain_root_id is not null
             and (previous_trajectory_id is not null or chain_root_id = id))
      not valid;
    alter table public.agent_trajectories
      validate constraint agent_trajectories_chain_root_set;
  end if;
end $$;
-- One row per segment of a chain (never a fork), and how an append finds the tail.
create unique index if not exists idx_trajectories_one_segment
  on public.agent_trajectories (tenant_id, chain_root_id, segment);
comment on column public.agent_trajectories.chain_root_id is
  'The first segment of this trajectory''s chain (review 12 M1): set by trigger, never changed.';

create or replace function public.agent_trajectories_chain_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  prev record;
begin
  if tg_op = 'UPDATE' then
    if new.segment is distinct from old.segment
       or new.previous_trajectory_id is distinct from old.previous_trajectory_id
       or new.step_offset is distinct from old.step_offset
       or new.chain_root_id is distinct from old.chain_root_id
       or new.tenant_id is distinct from old.tenant_id then
      raise exception 'agent_trajectories: a trajectory''s chain never changes after it is created'
        using errcode = 'check_violation';
    end if;
    -- A segment that has been continued keeps its step count (its continuation's step_offset
    -- counts them): no step added, none removed (review 13 L3 — a shrink misnumbered the chain as
    -- surely as a growth); an erasure's same-length rewrite of its steps is allowed.
    if (case when jsonb_typeof(new.steps) = 'array' then jsonb_array_length(new.steps) else 0 end)
       <> (case when jsonb_typeof(old.steps) = 'array' then jsonb_array_length(old.steps) else 0 end)
       and exists (select 1 from public.agent_trajectories c
                    where c.tenant_id = new.tenant_id and c.previous_trajectory_id = new.id) then
      raise exception 'agent_trajectories: a continued segment keeps its step count; steps go to the chain''s last segment'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.previous_trajectory_id is null then
    new.chain_root_id := new.id;
    return new;
  end if;
  -- Read under the writer's own row-level security: another tenant's row is not found. Locked
  -- (review 13 L3): a concurrent update of the predecessor's steps waits for this insert to
  -- commit (and is then refused: the segment has a continuation), and an update already in
  -- progress is waited for — its new step count is the one checked below. Without the lock an
  -- update growing the predecessor while its continuation was being inserted left the chain
  -- misnumbered.
  select p.id, p.tenant_id, p.segment, p.chain_root_id, p.step_offset,
         case when jsonb_typeof(p.steps) = 'array' then jsonb_array_length(p.steps) else 0 end as n
    into prev
    from public.agent_trajectories p where p.id = new.previous_trajectory_id
     for update;
  if not found or prev.tenant_id is distinct from new.tenant_id then
    raise exception 'agent_trajectories: a continuation''s predecessor must exist in its tenant'
      using errcode = 'check_violation';
  end if;
  if new.segment <> prev.segment + 1 then
    raise exception 'agent_trajectories: a continuation is its predecessor''s segment + 1'
      using errcode = 'check_violation';
  end if;
  if new.chain_root_id is not null and new.chain_root_id is distinct from prev.chain_root_id then
    raise exception 'agent_trajectories: a continuation belongs to its predecessor''s chain'
      using errcode = 'check_violation';
  end if;
  if new.step_offset <> prev.step_offset + prev.n then
    raise exception 'agent_trajectories: a continuation''s step_offset is the steps before it'
      using errcode = 'check_violation';
  end if;
  new.chain_root_id := prev.chain_root_id;
  return new;
end;
$$;
drop trigger if exists agent_trajectories_chain_guard on public.agent_trajectories;
create trigger agent_trajectories_chain_guard
  before insert or update on public.agent_trajectories
  for each row execute function public.agent_trajectories_chain_guard();
comment on function public.agent_trajectories_chain_guard() is
  'Keeps every trajectory chain linear, in one tenant and numbered (review 12 L6).';
revoke all on function public.agent_trajectories_chain_guard() from public, anon, authenticated;

-- ── Staff MFA (A-9) ─────────────────────────────────────────────────────────────────────────
insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier, tenant_overridable)
values
  ('auth.staff_mfa_required', 'true', 'true',
   'Staff (anyone using an administrative permission) must sign in with a second factor. Turning it off needs a second operator.',
   'auth', 'boolean', null, null, 'safety', false),
  ('admin.dual_control_actions',
   '["create_role","delete_role","duplicate_role","assign_permissions","change_user_role","create_entitlement_group","set_entitlement_group_active","set_approval_policy"]',
   '["create_role","delete_role","duplicate_role","assign_permissions","change_user_role","create_entitlement_group","set_entitlement_group_active","set_approval_policy"]',
   'Administrative actions held until a second administrator who holds the same permission approves them. Never an action whose effect is a config write (an agent''s registration or scope, a capability mapping): the key it writes is held under its own rules instead.',
   'system', 'json_array', null, null, 'safety', false),
  ('auth.token_cache_seconds', '30', '30',
   'Seconds a verified access token is answered from the shared cache instead of asking the identity provider again (at most 60, never past the token''s expiry; 0: always ask). Sign-out, account and role or MFA changes void it at once.',
   'auth', 'number', '0', '60', 'safety', false),
  ('agent.trajectory_max_segments', '20', '20',
   'The most segments one trajectory chain (an app session, a run that rolls over) may have; each segment holds at most 1,000 steps and 16 MiB. Past it the next action is refused (request.trajectory_chain_full). Raising it lets one session grow larger.',
   'agents', 'number', '1', '1000', 'safety', false),
  ('auth.token_stale_grace_seconds', '300', '300',
   'When the identity provider cannot answer (throttled, down), seconds past its fresh window an ordinary route may still accept a token it verified (never past the token''s expiry or a revocation). Privileged routes never do: they answer 503. 0 turns it off.',
   'auth', 'number', '0', '900', 'safety', false)
on conflict (key) do nothing;

-- ── Seeded once: dual control, and the stream feature in both governed lists ────────────────
-- Review 8 M2: every setting whose change is a change of power — who can do what, for how long,
-- and what may reach whom — is held for a second operator. Before, agent.capability_features
-- (what an agent may do) and the token windows were changed by one administrator through
-- PUT /api/admin/config. The audit of the safety-tier settings added: the token cache and its
-- stale grace (how long a revoked session can stand); agents' capabilities, trust and
-- delegation lifetime and the tenant's agent spend cap; what restricted and suspended accounts
-- may use, and the feature list that check is made against; the COPPA gate and what it blocks;
-- which profile fields are screened; every content-rating threshold and severity reduction;
-- the strike thresholds that warn and suspend; and how long an approval stays open.
--
-- Seeded once PER KEY (review 13 L4). Before, the whole list was added on this migration's first
-- application only, so a database that had run an earlier 052 never received a key added to the
-- list later (agent.trajectory_max_segments, review 12 M2): it was not dual-controlled there. Now
-- each key is seeded once, and config_dual_control_seeded records that it was:
--   * a key not recorded is added to config.dual_control_keys (if absent) and recorded;
--   * a key recorded is never added again, so an operator's removal of it stands;
--   * a database that ran an earlier 052 has no record yet: a key it already lists is recorded
--     (seeded before); a key an operator REMOVED — config history shows a platform-scope change of
--     config.dual_control_keys from a list holding it to one without it — is recorded and not
--     added back; a key neither listed nor ever removed was never seeded there: it is added.
-- A key added to this list in a later revision reaches every database on its next application.
create table if not exists public.config_dual_control_seeded (
  key text primary key,
  seeded_by text not null,
  outcome text not null check (outcome in ('added', 'already_listed', 'removed_by_operator')),
  seeded_at timestamptz not null default now()
);
comment on table public.config_dual_control_seeded is
  'Which keys a migration has seeded into config.dual_control_keys (review 13 L4): a recorded key is never seeded again, so an operator''s removal stands; a key never recorded is seeded on the next application.';
alter table public.config_dual_control_seeded enable row level security;
alter table public.config_dual_control_seeded force row level security;
revoke all on table public.config_dual_control_seeded from public;
do $$
begin
  -- The roles exist where the platform's roles were created (049, the shim); revoke only those.
  if exists (select 1 from pg_roles where rolname = 'app_tenant') then
    execute 'revoke all on table public.config_dual_control_seeded from app_tenant';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.config_dual_control_seeded from anon, authenticated';
  end if;
end $$;

with tracked(k, n) as (
  select k, n from unnest(array[
    'auth.staff_mfa_required', 'admin.dual_control_actions',
    'auth.token_cache_seconds', 'auth.token_stale_grace_seconds',
    'agent.capability_features', 'agent.trusted_agents',
    'agent.delegation.max_ttl_seconds', 'agent.budget.tenant_max_cost_per_day',
    'agent.trajectory_max_segments',
    'account_status.known_features', 'account_status.restricted_features',
    'account_status.suspended_features',
    'coppa.enforcement_enabled', 'coppa.blocked_features',
    'profile.screened_fields',
    'moderation.level1.block_severity', 'moderation.level1.warn_severity',
    'moderation.level1.escalate_below',
    'moderation.level2.block_severity', 'moderation.level2.warn_severity',
    'moderation.level2.escalate_below',
    'moderation.level3.block_severity', 'moderation.level3.warn_severity',
    'moderation.level3.escalate_below',
    'moderation.translation_severity_reduction',
    'moderation.transcription_severity_reduction',
    'moderation.extraction_severity_reduction',
    'moderation.strike_warn_threshold', 'moderation.strike_suspend_threshold',
    'config.approval_expiry_days'
  ]) with ordinality as t(k, n)
),
list as (
  select value from public.platform_config
   where key = 'config.dual_control_keys' and jsonb_typeof(value) = 'array'
),
unrecorded as (
  select tracked.k, tracked.n,
         case
           when (select value from list) @> jsonb_build_array(tracked.k) then 'already_listed'
           when exists (
             select 1 from public.platform_config_history h
              where h.config_key = 'config.dual_control_keys'
                and h.scope = 'platform'
                and jsonb_typeof(h.previous_value) = 'array'
                and h.previous_value @> jsonb_build_array(tracked.k)
                and not (coalesce(h.new_value, '[]'::jsonb) @> jsonb_build_array(tracked.k))
           ) then 'removed_by_operator'
           else 'added'
         end as outcome
    from tracked
   where exists (select 1 from list)
     and not exists (select 1 from public.config_dual_control_seeded s where s.key = tracked.k)
),
added as (
  update public.platform_config
     set value = value || (
       select coalesce(jsonb_agg(u.k order by u.n), '[]'::jsonb)
         from unrecorded u where u.outcome = 'added'
     )
   where key = 'config.dual_control_keys'
     and jsonb_typeof(value) = 'array'
     and exists (select 1 from unrecorded u where u.outcome = 'added')
  returning key
)
insert into public.config_dual_control_seeded (key, seeded_by, outcome)
select u.k, '052_audit_wave2.sql', u.outcome from unrecorded u
on conflict (key) do nothing;

update public.platform_config
   set value = value || '["stream"]'::jsonb,
       default_value = case
         when jsonb_typeof(default_value) = 'array' and not default_value @> '["stream"]'::jsonb
         then default_value || '["stream"]'::jsonb
         else default_value
       end
 where key in ('account_status.known_features', 'coppa.blocked_features')
   and jsonb_typeof(value) = 'array'
   and not value @> '["stream"]'::jsonb
   and not exists (
     select 1 from public.applied_migrations where filename = '052_audit_wave2.sql'
   );

-- ── A governed setting nothing read (D-20) — retired, its history kept (L2) ─────────────────
update public.platform_config
   set category = 'retired', permission_tier = 'safety', tenant_overridable = false,
       description = 'Retired in 052 (D-20): nothing reads it. Kept, with its change history, as the record of what it was; it is not listed and cannot be set.'
 where key = 'moderation.blocklist_only_surfaces'
   and category is distinct from 'retired';
update public.config_pending_approvals
   set status = 'expired',
       review_comment = coalesce(review_comment, 'The setting was retired (052, D-20).')
 where config_key = 'moderation.blocklist_only_surfaces'
   and status = 'pending';
update public.platform_config
   set value = value - 'moderation.blocklist_only_surfaces'
 where key = 'config.dual_control_keys'
   and jsonb_typeof(value) = 'array'
   and value ? 'moderation.blocklist_only_surfaces';

-- ── The deletion manifest (E-7) ─────────────────────────────────────────────────────────────
update public.deletion_manifest m
   set table_names = array(
     select t.name from unnest(m.table_names) with ordinality as t(name, n)
      where t.name not in ('players', 'player_devices', 'player_entitlements')
         or exists (select 1 from pg_class c
                     where c.relnamespace = 'public'::regnamespace and c.relname = t.name)
      order by t.n)
 where exists (
   select 1 from unnest(m.table_names) as t(name)
    where t.name in ('players', 'player_devices', 'player_entitlements')
      and not exists (select 1 from pg_class c
                       where c.relnamespace = 'public'::regnamespace and c.relname = t.name)
 );
delete from public.deletion_manifest where cardinality(table_names) = 0;
insert into public.deletion_manifest (module_name, table_names, description)
select 'platform',
       array['review_queue', 'user_strikes', 'user_feature_restrictions', 'content_safety_audit',
             'user_interactions', 'user_ai_context', 'proposals', 'agent_trajectories',
             'agent_budgets', 'ai_metrics', 'document_embeddings', 'rate_limit_events',
             'app_sessions',
             'group_invites', 'group_memberships', 'groups', 'consent_records', 'user_devices',
             'user_entitlements', 'password_policy', 'audit_log', 'users'],
       'The platform''s tables that hold a user''s data (platform/auth/user-data.ts): deleted on erasure, or anonymised where a record is kept (audit log, moderation decisions, decisions about other accounts).'
 where not exists (select 1 from public.deletion_manifest where module_name = 'platform');

insert into public.applied_migrations (filename, confidence, note)
values (
  '052_audit_wave2.sql',
  'verified',
  'October 2026 audit, Wave 2: logout audit action (A-12); user_deletions standing and email hash (A-11); auth.staff_mfa_required and admin.dual_control_actions, dual-controlled (A-9, X-10); stream in the known and consent-gated features (X-16); moderation.blocklist_only_surfaces retired, its history kept (D-20); the deletion manifest made true (E-7).'
)
on conflict (filename) do nothing;
