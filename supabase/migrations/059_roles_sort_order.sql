-- ============================================================================
-- 059_roles_sort_order.sql — the roles in a logical order (TASK-192)
--
-- Every list of roles is ordered by `sort_order, name`, but the seeded values never lined up
-- across migrations (dev: guest 0, free 1 … admin 6, super_admin 7, moderator 8, safety_approver
-- 4 beside annual), so the Roles screen read as arbitrary. The owner's order: staff first (Super
-- Admin, Admin, Moderator, Safety Approver), then the plans from smallest to largest (Guest, Free,
-- Daily, Monthly, Annual, Lifetime), then every other role by name.
--
--   1. The column's default becomes 1000 (NEW_ROLE_SORT_ORDER, platform/auth/catalog-order.ts),
--      so a role inserted without a value sorts after the seeded ones, with the rest by name. The
--      command bar's create and duplicate write the same value (they wrote 99).
--   2. The seeded roles, by name, get 10, 20 … 100 (gaps of 10 leave room between two). A role a
--      database does not have is skipped: its update matches no row.
--   3. Any other role still at an old default — 0 (the column's) or 99 (the command bar's; dev's
--      hand-made `tester`) — moves to 1000. A value a consumer chose is left as it is (TASK-192
--      round 1): an app's role at 55 stays between guest and free.
--
-- Idempotent: an update changes only a row whose value differs, so applied again it changes no
-- row (and no role's updated_at: the roles trigger sets it on every update). Applied the first
-- time, each role whose position changed shows that day as its Modified date.
-- Lock: the default first — ACCESS EXCLUSIVE on roles for a catalog change, no rewrite — then
-- ROW EXCLUSIVE on the rows it changes (a few dozen at most). lock_timeout 5s: on a busy roles
-- table it fails rather than queueing every reader behind it; run it again. The code works before
-- it: the lists are only in the old order.
-- ============================================================================

set local lock_timeout = '5s';

alter table public.roles alter column sort_order set default 1000;

update public.roles set sort_order = 10 where name = 'super_admin' and sort_order <> 10;
update public.roles set sort_order = 20 where name = 'admin' and sort_order <> 20;
update public.roles set sort_order = 30 where name = 'moderator' and sort_order <> 30;
update public.roles set sort_order = 40 where name = 'safety_approver' and sort_order <> 40;
update public.roles set sort_order = 50 where name = 'guest' and sort_order <> 50;
update public.roles set sort_order = 60 where name = 'free' and sort_order <> 60;
update public.roles set sort_order = 70 where name = 'daily' and sort_order <> 70;
update public.roles set sort_order = 80 where name = 'monthly' and sort_order <> 80;
update public.roles set sort_order = 90 where name = 'annual' and sort_order <> 90;
update public.roles set sort_order = 100 where name = 'lifetime' and sort_order <> 100;

update public.roles set sort_order = 1000
 where name not in ('super_admin', 'admin', 'moderator', 'safety_approver', 'guest', 'free',
                    'daily', 'monthly', 'annual', 'lifetime')
   and (sort_order is null or sort_order in (0, 99));

insert into public.applied_migrations (filename, confidence, note)
values (
  '059_roles_sort_order.sql',
  'verified',
  'roles.sort_order: staff 10-40, plans 50-100, any other role at an old default (0, 99) 1000; the column default 1000 (TASK-192).'
)
on conflict (filename) do nothing;
