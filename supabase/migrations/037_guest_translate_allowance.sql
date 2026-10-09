-- ============================================================================
-- Migration: 037_guest_translate_allowance.sql
--
-- Sprint 7A B1 — the governed per-guest translate allowance (ADR-050 D4, TASK-099).
-- Idempotent and re-runnable.
--
--   1. platform_config 'guest.translate_allowance' — how many translate requests a guest
--      may make before signing in. Integer 1–10, default 5, safety tier, dual control.
--      The platform also clamps it to 1–10 in code, so a bad row cannot lift the cap.
--   2. guest_usage — one row per guest id: translations used so far. Service role only.
--   3. guest_allowance_consume(guest_id, limit) — atomic consume-if-under-limit. Two
--      requests racing for the last unit cannot both succeed: the conditional upsert takes
--      the row lock, and a guest at the limit gets allowed = false with nothing written.
-- ============================================================================

-- ── 1. Governed allowance ──────────────────────────────────────────────────

INSERT INTO platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier)
VALUES
  (
    'guest.translate_allowance', '5', '5',
    'Translate requests a guest may make before signing in (one per request, whatever the number of target languages). Enforced before any paid call; at the limit the guest is asked to sign in. The platform clamps it to 1–10 whatever this row says.',
    'guest', 'number', '1', '10', 'safety'
  )
ON CONFLICT (key) DO NOTHING;

UPDATE platform_config
SET value = value || '["guest.translate_allowance"]'::jsonb
WHERE key = 'config.dual_control_keys'
  AND NOT (value @> '["guest.translate_allowance"]'::jsonb);

-- ── 2. Usage ───────────────────────────────────────────────────────────────

create table if not exists guest_usage (
  guest_id          text primary key,
  translations_used integer not null default 0 check (translations_used >= 0),
  first_used_at     timestamptz not null default now(),
  last_used_at      timestamptz not null default now()
);

alter table guest_usage enable row level security;
-- No policies: only the service role (which bypasses RLS) reads or writes guest usage.

comment on table guest_usage is
  'Per-guest consumption of the guest translate allowance (ADR-050 D4). Guest ids are platform-minted and namespaced (guest_ + 128 bits). Service role only.';

-- ── 3. Atomic consume ──────────────────────────────────────────────────────

create or replace function guest_allowance_consume(p_guest_id text, p_limit integer)
returns table (allowed boolean, used integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_used integer;
begin
  if p_guest_id is null or p_guest_id !~ '^guest_[a-z0-9]{32}$' then
    raise exception 'guest_allowance_consume: invalid guest id';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'guest_allowance_consume: invalid limit';
  end if;

  insert into guest_usage as g (guest_id, translations_used)
  values (p_guest_id, 1)
  on conflict (guest_id) do update
    set translations_used = g.translations_used + 1,
        last_used_at      = now()
    where g.translations_used < p_limit
  returning g.translations_used into v_used;

  if v_used is null then
    -- At the limit: the conditional update matched nothing. Report the current count.
    select g.translations_used into v_used from guest_usage g where g.guest_id = p_guest_id;
    return query select false, coalesce(v_used, p_limit);
  else
    return query select true, v_used;
  end if;
end;
$$;

revoke all on function guest_allowance_consume(text, integer) from public, anon, authenticated;
grant execute on function guest_allowance_consume(text, integer) to service_role;

insert into applied_migrations (filename, confidence, note)
values (
  '037_guest_translate_allowance.sql',
  'verified',
  'Sprint 7A B1 (ADR-050 D4, TASK-099): governed guest.translate_allowance (1-10, default 5, safety tier, dual control); guest_usage table (service role only); atomic guest_allowance_consume().'
);
