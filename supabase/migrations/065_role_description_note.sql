-- 065_role_description_note.sql — a duplicated role's note is a catalog key and its values, not
-- English written by SQL (TASK-207, N-107)
--
-- Duplicating a role (the console's duplicate_role, app/api/admin/ai/handlers/roles.ts) wrote the
-- new role's description as 'Duplicated from <source>. <the source's description>' — English the
-- database wrote, shown on the Roles screen in every locale. Now the note is stored as a screen
-- message's key and values in roles.description_note (platform/errors/shown-text.ts: {"key",
-- "params"}), rendered by the screen; roles.description keeps only what an administrator wrote
-- (the source's description, copied).
--
-- 1. roles.description_note: jsonb, nullable; when set, an object with a "key" that is a screen
--    message (`screens.…`) — a check, so nothing else is stored there.
-- 2. Rows written before this migration are migrated: a description that begins
--    'Duplicated from <name>. ' becomes the note {"key":
--    "screens.admin_console.roles.duplicated_from", "params": {"source": "<name>"}} and the rest of
--    the text (what the source's description was). A role name has no spaces (a slug), so the name
--    ends at the first '. '. A row whose description an administrator has since rewritten does not
--    begin so and is left as it is. Rows already migrated (a note set) are not read again.
--
-- Idempotent: `add column if not exists`, the check added only when absent, the update only on rows
-- without a note, the record upserted. Locks: roles ACCESS EXCLUSIVE briefly while the column (no
-- default: no rewrite) and the check (validated against its rows: a few dozen roles) are added,
-- then the rows updated. lock_timeout 5 s: on a busy table it fails rather than queueing others
-- behind it; run it again. Apply it as ONE run.

set local lock_timeout = '5s';

-- ── 1. The column ────────────────────────────────────────────────────────────────────────────
alter table public.roles add column if not exists description_note jsonb;

comment on column public.roles.description_note is
  'A note the platform adds to a role, as a screen message''s key and values ({"key": "screens.…", "params": {…}}), rendered by the Roles screen in the viewer''s locale (platform/errors/shown-text.ts). Set when a role is duplicated (screens.admin_console.roles.duplicated_from, its source). Null when there is none. TASK-207.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'roles_description_note_shown'
       and conrelid = 'public.roles'::regclass
  ) then
    alter table public.roles add constraint roles_description_note_shown check (
      description_note is null
      or (jsonb_typeof(description_note) = 'object'
          and jsonb_typeof(description_note -> 'key') = 'string'
          and (description_note ->> 'key') like 'screens.%'
          and (not description_note ? 'params'
               or jsonb_typeof(description_note -> 'params') = 'object'))
    );
  end if;
end $$;

-- ── 2. Rows duplicated before this migration ─────────────────────────────────────────────────
update public.roles r
   set description_note = jsonb_build_object(
         'key', 'screens.admin_console.roles.duplicated_from',
         'params', jsonb_build_object('source', m.parts[1])
       ),
       description = m.parts[2]
  from (
    select id, regexp_match(description, '^Duplicated from (\S+)\. (.*)$') as parts
      from public.roles
     where description_note is null
       and description like 'Duplicated from %'
  ) m
 where r.id = m.id
   and m.parts is not null;

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '065_role_description_note.sql',
  'verified',
  'TASK-207: a duplicated role''s note is a catalog key and values in roles.description_note, rendered by the Roles screen; rows written before are migrated (N-107).',
  'sha256:579a1c507e93c1ed39dce7f093dfb34810fa81798d1a1492c5cb66195a4d222e'
)
on conflict (filename) do update set checksum = excluded.checksum;
