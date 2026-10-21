-- ============================================================================
-- Migration: 039_rate_limit.sql
--
-- Shared rate limiting in Postgres (ADR-052, TASK-134). Idempotent and re-runnable.
--
--   1. rate_limit_events — one row per counted request, per bucket. A bucket is the limiter's
--      key: namespace + rule id + caller identity (e.g. "rl:auth:login:ip:203.0.113.7").
--      Service role only.
--   2. rate_limit_hit(bucket, limit, window_seconds, consume) — an exact sliding window.
--      Serialised per bucket with a transaction-scoped advisory lock, so concurrent requests
--      for one bucket can never admit more than the limit; different buckets never wait on
--      each other. consume = false peeks without counting. Times come from the database
--      clock, so every application instance agrees.
--   3. rate_limit_reset(bucket) — forget a bucket (an admin unlocking a caller, or tests).
--
-- Expired rows are deleted per bucket on every call, and, on about one call in a hundred,
-- across all buckets older than the longest window allowed (one day). The table therefore stays
-- bounded by the traffic of the last day.
-- ============================================================================

create table if not exists rate_limit_events (
  id     bigserial primary key,
  bucket text        not null check (char_length(bucket) between 1 and 512),
  at     timestamptz not null default clock_timestamp()
);

create index if not exists rate_limit_events_bucket_at on rate_limit_events (bucket, at);
create index if not exists rate_limit_events_at on rate_limit_events (at);

alter table rate_limit_events enable row level security;
-- No policies: only the service role (which bypasses RLS) reads or writes rate-limit events.

comment on table rate_limit_events is
  'Counted requests per rate-limit bucket (ADR-052). Rows older than one day are swept. Service role only.';

create or replace function rate_limit_hit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer,
  p_consume boolean default true
)
returns table (allowed boolean, used integer, retry_after_seconds integer, reset_at bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now    timestamptz := clock_timestamp();
  v_start  timestamptz;
  v_used   integer;
  v_oldest timestamptz;
begin
  if p_bucket is null or char_length(p_bucket) not between 1 and 512 then
    raise exception 'rate_limit_hit: invalid bucket';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000000 then
    raise exception 'rate_limit_hit: invalid limit';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'rate_limit_hit: invalid window';
  end if;

  -- One caller at a time per bucket; released when the transaction ends.
  perform pg_advisory_xact_lock(hashtextextended(p_bucket, 0));

  v_start := v_now - make_interval(secs => p_window_seconds);
  delete from rate_limit_events e where e.bucket = p_bucket and e.at <= v_start;

  select count(*)::integer, min(e.at) into v_used, v_oldest
  from rate_limit_events e where e.bucket = p_bucket;

  if random() < 0.01 then
    delete from rate_limit_events e where e.at < v_now - interval '1 day';
  end if;

  if v_used >= p_limit then
    return query select
      false,
      v_used,
      greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - v_now)))::integer),
      ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds))))::bigint;
    return;
  end if;

  if p_consume then
    insert into rate_limit_events (bucket, at) values (p_bucket, v_now);
    v_used := v_used + 1;
    if v_oldest is null then
      v_oldest := v_now;
    end if;
  end if;

  return query select
    true,
    v_used,
    0,
    ceil(extract(epoch from (coalesce(v_oldest, v_now) + make_interval(secs => p_window_seconds))))::bigint;
end;
$$;

create or replace function rate_limit_reset(p_bucket text)
returns void
language sql
security invoker
set search_path = public
as $$
  delete from rate_limit_events where bucket = p_bucket;
$$;

revoke all on function rate_limit_hit(text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function rate_limit_reset(text) from public, anon, authenticated;
grant execute on function rate_limit_hit(text, integer, integer, boolean) to service_role;
grant execute on function rate_limit_reset(text) to service_role;

insert into applied_migrations (filename, confidence, note)
values (
  '039_rate_limit.sql',
  'verified',
  'ADR-052 (TASK-134): rate_limit_events (service role only); exact sliding-window rate_limit_hit() serialised per bucket by advisory lock; rate_limit_reset().'
)
on conflict (filename) do nothing;
