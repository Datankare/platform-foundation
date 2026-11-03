-- 063_applied_migrations_checksum.sql — each migration records the checksum of its own file
-- (TASK-197, audit D-11)
--
-- Migration parity (scripts/migration-parity.mjs) compared file names only, so a migration edited
-- after it was applied — 052 changed across reviews 8 to 14 — still read as in parity. From this
-- migration on, each one's applied_migrations record carries `checksum`: "sha256:" and the hash
-- of its file, with its own stamp zeroed (scripts/migration-checksum.mjs stamps it; the tracking
-- test requires it). Parity compares the database's record with the repository's file, and an
-- edit after application is drift. Rows recorded before this migration have no checksum (null):
-- what was applied then cannot be known now, and parity says how many.
-- Numbered 063 in the 2026-10-29 sweep: 060, 061 and 062 (other batches) come before it and so
-- record no checksum either; the rule holds from 063.
--
-- Re-applying a migration records the checksum of the file applied last (on conflict … do update
-- set checksum), so the record says what the database now holds.
--
-- Idempotent: `add column if not exists`, a constraint added only when absent, the record upserted.
-- One table, a brief lock; no data rewritten (a nullable column without a default).

set local lock_timeout = '5s';

alter table public.applied_migrations add column if not exists checksum text;

comment on column public.applied_migrations.checksum is
  'The checksum of the migration file this record was written by: "sha256:" and the SHA-256 of its text, with line endings as LF and this record''s own checksum literal read as zeros (scripts/migration-checksum.mjs). Null for a migration recorded before 063. Compared with the repository by scripts/migration-parity.mjs (TASK-197).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'applied_migrations_checksum_shape'
      and conrelid = 'public.applied_migrations'::regclass
  ) then
    alter table public.applied_migrations
      add constraint applied_migrations_checksum_shape
      check (checksum is null or checksum ~ '^sha256:[0-9a-f]{64}$');
  end if;
end $$;

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '063_applied_migrations_checksum.sql',
  'verified',
  'applied_migrations.checksum: each migration from 063 records its file''s checksum; parity compares it (TASK-197).',
  'sha256:2c3411b964376e188859041c3563bc2b6ebccd8f49cb81955e0f34f47b0def9d'
)
on conflict (filename) do update set checksum = excluded.checksum;
