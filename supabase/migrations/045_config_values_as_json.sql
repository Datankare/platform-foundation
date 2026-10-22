-- 045_config_values_as_json.sql — governed config values stored as JSON, not as JSON text (Sprint 7X)
--
-- The governed config writers passed JSON.stringify(value) to jsonb columns, so a list, number
-- or boolean was stored as a JSON *string* ("[\"a\"]", "200", "true"). Readers take the column
-- as it is, so after any edit through the admin screens a governed list read as text, a quota as
-- a string (and fell back to its default), and the dual-control list held nothing. The writers
-- now store the value itself (release review, Sprint 7X). This repairs rows written the old way:
-- a value whose setting is not a string type, stored as a JSON string that itself parses as
-- JSON, becomes the parsed value. Settings of type string / string_enum are never touched.
--
-- normalize_config_json() is idempotent and safe to run again; migration-replay.sh exercises it
-- on deliberately stringified rows.

create or replace function public.normalize_config_json()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  r record;
  parsed jsonb;
  fixed integer := 0;
begin
  -- platform_config: value and default_value, by the setting's own type.
  for r in
    select key, value, default_value
    from platform_config
    where value_type not in ('string', 'string_enum')
      and (jsonb_typeof(value) = 'string' or jsonb_typeof(default_value) = 'string')
  loop
    if jsonb_typeof(r.value) = 'string' then
      begin
        parsed := (r.value #>> '{}')::jsonb;
        if jsonb_typeof(parsed) <> 'string' then
          update platform_config set value = parsed where key = r.key;
          fixed := fixed + 1;
        end if;
      exception when others then null; -- not JSON text: leave it for a person to look at
      end;
    end if;
    if jsonb_typeof(r.default_value) = 'string' then
      begin
        parsed := (r.default_value #>> '{}')::jsonb;
        if jsonb_typeof(parsed) <> 'string' then
          update platform_config set default_value = parsed where key = r.key;
          fixed := fixed + 1;
        end if;
      exception when others then null;
      end;
    end if;
  end loop;

  -- History and pending approvals, by the type of the setting they belong to.
  for r in
    select h.id, h.previous_value, h.new_value
    from platform_config_history h
    join platform_config c on c.key = h.config_key
    where c.value_type not in ('string', 'string_enum')
      and (jsonb_typeof(h.new_value) = 'string' or jsonb_typeof(h.previous_value) = 'string')
  loop
    begin
      if jsonb_typeof(r.new_value) = 'string' then
        parsed := (r.new_value #>> '{}')::jsonb;
        if jsonb_typeof(parsed) <> 'string' then
          update platform_config_history set new_value = parsed where id = r.id;
          fixed := fixed + 1;
        end if;
      end if;
    exception when others then null;
    end;
    begin
      if jsonb_typeof(r.previous_value) = 'string' then
        parsed := (r.previous_value #>> '{}')::jsonb;
        if jsonb_typeof(parsed) <> 'string' then
          update platform_config_history set previous_value = parsed where id = r.id;
          fixed := fixed + 1;
        end if;
      end if;
    exception when others then null;
    end;
  end loop;

  for r in
    select a.id, a.current_value, a.proposed_value
    from config_pending_approvals a
    join platform_config c on c.key = a.config_key
    where c.value_type not in ('string', 'string_enum')
      and (jsonb_typeof(a.proposed_value) = 'string' or jsonb_typeof(a.current_value) = 'string')
  loop
    begin
      if jsonb_typeof(r.proposed_value) = 'string' then
        parsed := (r.proposed_value #>> '{}')::jsonb;
        if jsonb_typeof(parsed) <> 'string' then
          update config_pending_approvals set proposed_value = parsed where id = r.id;
          fixed := fixed + 1;
        end if;
      end if;
    exception when others then null;
    end;
    begin
      if jsonb_typeof(r.current_value) = 'string' then
        parsed := (r.current_value #>> '{}')::jsonb;
        if jsonb_typeof(parsed) <> 'string' then
          update config_pending_approvals set current_value = parsed where id = r.id;
          fixed := fixed + 1;
        end if;
      end if;
    exception when others then null;
    end;
  end loop;

  return fixed;
end;
$$;

revoke execute on function public.normalize_config_json() from public, anon, authenticated;
grant execute on function public.normalize_config_json() to service_role;

select public.normalize_config_json();

insert into applied_migrations (filename, confidence, note)
values (
  '045_config_values_as_json.sql',
  'verified',
  'Sprint 7X release review: governed config values written as JSON text are repaired to JSON (normalize_config_json, idempotent).'
)
on conflict (filename) do nothing;
