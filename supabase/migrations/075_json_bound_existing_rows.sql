-- 075_json_bound_existing_rows.sql — every row stored before the bound read once against it
-- (platform TASK-229, design 56e-3a)
--
-- ONE read-only statement over the data (a DO block): public.json_bound_check() reads every row
-- of every table 074 covers, one scan per table, and refuses — naming the table, the column and the
-- row (its primary key when made of uuids and integers, else its ctid with the key withheld) and
-- the reason — if a value is over the bound: deeper than 128 levels, holding a number other than 0
-- or 1e-18 <= |n| < 1e21, or longer than 8 MiB as text (design 56e-3a §2.2). The test is the
-- triggers' own (json_bound_term). Rows written after 074 were tested by its triggers.
-- Takes no lock that blocks a write (ACCESS SHARE while reading; a SHARE UPDATE EXCLUSIVE moment per
-- table to mark it read). Needs a role that sees every row (superuser or BYPASSRLS: postgres on
-- Supabase); otherwise it says so and changes nothing. Above about 3 GB of JSON the SQL Editor's
-- time limit can stop it: then run, table by table, select public.json_bound_check('public.<table>');
-- and paste this file last (docs/MIGRATION_v5_to_v6.md).
do $m075$
begin
  if pg_catalog.to_regprocedure('public.json_bound_check(regclass)') is null then
    raise exception '075: migration 074 is not applied; apply 074 first';
  end if;
  perform public.json_bound_check();

  insert into public.applied_migrations (filename, confidence, note, checksum)
  values (
    '075_json_bound_existing_rows.sql',
    'verified',
    'TASK-229 (design 56e-3a): every row stored before migration 074 read once against the JSON bound (json_bound_check).',
    'sha256:5b486d19e31a276090bcf2641d6fcffb03d00953866de5d7d55767d6a495fe48'
  )
  on conflict (filename) do update set checksum = excluded.checksum;
end
$m075$;
