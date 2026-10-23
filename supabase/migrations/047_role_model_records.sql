-- 047_role_model_records.sql — the migration record tells the truth about the role model
-- (Sprint 7R R2, TASK-148)
--
-- The role model every database runs is flat: each role holds its own permissions directly
-- (guest 2, free and each paid tier the same 7, admin 14, super_admin 17, moderator 2,
-- safety_approver 3), `free` is the default role new users are provisioned with
-- (platform/auth/user-provisioning.ts), and role_inheritance is empty. The code reads exactly
-- that.
--
-- 007_seed_separation.sql describes a different model — a generic `registered` default role with
-- an inheritance chain — that was never applied to any database: `registered` exists nowhere.
-- Yet the dev database records it as "assumed" and the schema baseline (and so production) as
-- "verified". The first live run of the migration-parity check (2026-10-23) led to this.
--
-- This changes no role or permission. It marks 007 "absent" (known not applied) wherever its
-- effect is absent, so the record no longer claims what did not happen. Where a database really
-- has `registered`, the record is left alone. Idempotent.

update applied_migrations
set confidence = 'absent',
    note = 'Never applied as written: no `registered` role exists. The role model in force is flat '
      || '(direct permissions per role, `free` the default, no inheritance); see 047_role_model_records.sql.'
where filename = '007_seed_separation.sql'
  and not exists (select 1 from roles where name = 'registered');

insert into applied_migrations (filename, confidence, note)
values (
  '047_role_model_records.sql',
  'verified',
  'Sprint 7R R2 (TASK-148): 007_seed_separation recorded "absent" where its `registered` role does not exist; no role or permission changed.'
)
on conflict (filename) do nothing;
