-- 071_tenant_export_named_columns.sql — a tenant's export reads named columns, never whole rows
-- (TASK-215, audit A-7)
--
-- The operator's export of a tenant read every row as `to_jsonb(r)` (migration 049,
-- tenant_export_rows): every column of every tenant table — the network addresses on audit and
-- consent records, jobs' payloads and lease tokens, what an erasure keeps of a banned address, and
-- every column any later migration adds — went into the file without anyone deciding it should.
-- Now the export names the columns: the register of every tenant table's columns, each given or
-- not and why (platform/auth/user-data.ts TENANT_EXPORT_COLUMNS; an app's own tables in its
-- platform/tenancy/app-tenant-export.ts APP_TENANT_EXPORT), held to the schema by
-- __tests__/db/export-columns.db.test.ts. The code passes a table's given columns:
--
--   tenant_export_rows(table, tenant, columns)   one table's rows of one tenant, each a JSON object
--                                                of exactly the named columns. Refuses a table that
--                                                is not a tenant table, an empty list, a name that
--                                                is not a column of the table (and the tenant key,
--                                                which the export's first line carries), and a
--                                                name given twice.
--
-- The two-argument form, which read the whole row, is dropped: nothing may read whole rows again
-- through it (the whole-row guard, __tests__/whole-row-reads.test.ts, counts a function only while
-- no later migration replaces or drops it). Both are the owner's only, as in 049.
--
-- Idempotent: the new function created or replaced, the old one dropped if it exists. No table is
-- changed or locked. Apply it as ONE run. A documented step that applies 049 again re-creates the
-- whole-row form: apply this one after it, in the same run (scripts/migration-replay.sh does).

create or replace function public.tenant_export_rows(p_table text, p_tenant uuid, p_columns text[])
returns setof jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_column text;
  v_parts text[] := '{}';
  v_chunk text[] := '{}';
begin
  if not exists (select 1 from public.tenant_tables() t where t.table_name = p_table) then
    raise exception 'tenant_export_rows: % is not a tenant table', p_table;
  end if;
  if p_columns is null or cardinality(p_columns) = 0 then
    raise exception 'tenant_export_rows: no columns named for %', p_table;
  end if;
  if (select count(distinct c) from unnest(p_columns) c) <> cardinality(p_columns) then
    raise exception 'tenant_export_rows: a column of % is named twice', p_table;
  end if;
  foreach v_column in array p_columns loop
    if v_column is null or v_column = 'tenant_id' or not exists (
      select 1 from pg_catalog.pg_attribute a
       where a.attrelid = format('public.%I', p_table)::regclass
         and a.attname = v_column and a.attnum > 0 and not a.attisdropped
    ) then
      raise exception 'tenant_export_rows: % is not an exported column of %', v_column, p_table;
    end if;
    -- jsonb_build_object takes at most 100 arguments: 40 columns to an object, the objects merged.
    v_chunk := v_chunk || format('%L, r.%I', v_column, v_column);
    if cardinality(v_chunk) = 40 then
      v_parts := v_parts || format('jsonb_build_object(%s)', array_to_string(v_chunk, ', '));
      v_chunk := '{}';
    end if;
  end loop;
  if cardinality(v_chunk) > 0 then
    v_parts := v_parts || format('jsonb_build_object(%s)', array_to_string(v_chunk, ', '));
  end if;
  return query execute format(
    'select %s from public.%I r where r.tenant_id = $1',
    array_to_string(v_parts, ' || '),
    p_table
  ) using p_tenant;
end;
$$;

drop function if exists public.tenant_export_rows(text, uuid);

revoke all on function public.tenant_export_rows(text, uuid, text[]) from public;

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '071_tenant_export_named_columns.sql',
  'verified',
  'TASK-215 (audit A-7): tenant_export_rows(table, tenant, columns) reads the named, classified columns of a tenant table; the whole-row form is dropped.',
  'sha256:4af3eab8f6295ed28d0ceec9b68de3eb1734434204b88e31044410f17650d5d9'
)
on conflict (filename) do update set checksum = excluded.checksum;
