-- Migration 018: app_sessions — application framework state store (ADR-028 D2)
--
-- Persistent backing for SupabaseActivityStateStore. `state` is domain-opaque JSONB;
-- `version` is the optimistic-concurrency counter (D5); `produced_by` records the action
-- (operationId) that produced each version, giving the reconstructible-state guarantee (D2).

create table if not exists app_sessions (
  id           text primary key,
  state        jsonb       not null,
  version      integer     not null default 1,
  produced_by  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The CAS path filters on (id, version); the primary key covers id, and version is small.
-- An explicit index on (id, version) keeps the conditional UPDATE index-only under contention.
create index if not exists app_sessions_id_version_idx on app_sessions (id, version);

comment on table app_sessions is
  'ActivitySession versioned state (ADR-028 D2/D5). Authoritative system of record; trajectory persistence is separate (platform/agents).';
comment on column app_sessions.version is
  'Optimistic-concurrency counter. Commits are CAS: UPDATE ... WHERE version = expected (ADR-028 D5).';
comment on column app_sessions.produced_by is
  'operationId of the action that produced this version — reconstructible-state guarantee (ADR-028 D2).';
