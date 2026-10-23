-- 048_ai_metrics.sql — the table SupabaseMetricsSink writes (Sprint 7R R2, TASK-113)
--
-- platform/observability/metrics-sink.ts reads and writes ai_metrics through the REST API, but no
-- migration created it, so selecting the Supabase sink failed on its first flush. Columns are
-- exactly what the sink writes and filters on (name, timestamp, trace_id, values, tags).
--
-- Server-only: row-level security is on with no policy, and the public roles hold no privilege,
-- so only the service role (which the sink uses) reads or writes it. Idempotent.

create table if not exists public.ai_metrics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  "timestamp" timestamptz not null,
  trace_id text,
  "values" jsonb not null default '{}'::jsonb,
  tags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_metrics_name_not_blank check (length(trim(name)) > 0),
  constraint ai_metrics_values_object check (jsonb_typeof("values") = 'object'),
  constraint ai_metrics_tags_object check (jsonb_typeof(tags) = 'object')
);

comment on table public.ai_metrics is
  'Operational AI metrics written by SupabaseMetricsSink (TASK-113). Server-only: RLS on, no policy, no public grants.';

-- The sink's query: by name, newest first, since a time.
create index if not exists ai_metrics_name_timestamp_idx on public.ai_metrics (name, "timestamp" desc);
create index if not exists ai_metrics_timestamp_idx on public.ai_metrics ("timestamp" desc);

alter table public.ai_metrics enable row level security;
revoke all on table public.ai_metrics from anon, authenticated;
-- Explicit, not inherited from a project's default privileges: the sink inserts and queries.
grant select, insert on table public.ai_metrics to service_role;

insert into applied_migrations (filename, confidence, note)
values (
  '048_ai_metrics.sql',
  'verified',
  'Sprint 7R R2 (TASK-113): ai_metrics created for SupabaseMetricsSink — server-only (RLS, no policy, no public grants).'
)
on conflict (filename) do nothing;
