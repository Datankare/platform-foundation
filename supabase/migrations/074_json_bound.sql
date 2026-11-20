-- 074_json_bound.sql — every stored JSON value bounded: 128 levels, 8 MiB of text as printed, and
-- numbers that print short; whoever writes it. Today's erasure rewrites lose no value and never
-- straddle an escape (platform TASK-229, design 56e-3a; the bound: docs/JSON_BOUND.md)
--
-- ONE statement (a DO block): it applies whole or not at all in every client — the SQL Editor,
-- psql -f with or without --single-transaction (review B-6, DB-4). It reads no table row.
--
-- 1. The bound. Two BEFORE triggers on every table in public that has a jsonb column —
--    zz_json_bound_ins (INSERT) and zz_json_bound_upd (UPDATE, no column list) — named to fire after
--    every other BEFORE trigger, enabled ALWAYS (they fire under session_replication_role =
--    replica too). The whole test is in WHEN, built-in functions only, so no PL/pgSQL runs unless a
--    write is refused and no role needs EXECUTE on anything of ours to write (review B-7). A value
--    is refused when (cheapest test first, each later one only if the earlier ones pass):
--      its size as stored, decompressed, is over 4 x 8 MiB + 64 KiB (then it certainly prints
--        more than 8 MiB: a value's binary form is at most 4 x its text + 32 bytes, measured);
--      it nests deeper than 128 levels;
--      it holds a number other than 0 or 1e-18 <= |n| < 1e21 (such numbers print hundreds to
--        100 000 characters from a few stored bytes; the application never writes one);
--      it prints longer than 8 MiB of text (what every erasure path reads).
--    The size is the printed text, the one measure of every batch (docs/JSON_BOUND.md §1).
--    On UPDATE a value is "unchanged" only when it is the same stored toast pointer as the old one
--    (pg_column_toast_chunk_id equal and not null), so an update of another column never reads a
--    value stored out of line (reviews B-4, RB2-5); a value held in line, or a new one, is always
--    tested — equality of two jsonb values says nothing of how they print (0 equals 0e-16383:
--    code review A-1). agent_trajectories.steps (one document per run until migration 076 makes the steps
--    rows) is bounded in depth only; 076 drops the column and every step row gets the whole bound.
-- 2. public.json_bound_install([tables]): makes the triggers from the catalogue (json_bound_ddl);
--    the repair after the emergency off, and what a later migration adding a jsonb column calls.
--    It touches only tables whose triggers are not exactly in force; given tables, only those.
--    It takes TRIGGER on every covered table away from anon, authenticated and service_role
--    (Supabase grants it by default; a role holding it can replace a trigger: code review A-7).
--    A migration older than this one applied again (049, 050: "grant all … to service_role")
--    gives it back: readiness names the table, and json_bound_install() takes it away again.
--    A table it (re)makes is "rows not checked" until json_bound_check() has read it (075 runs it
--    the first time). The mark names the triggers' catalogue versions, so a trigger disabled and
--    enabled again in between is "rows not checked" too (review TA-a-3), and so is a table that
--    gained a partition (code review A-5).
-- 3. public.json_bound_missing(): readiness — every way the bound is not in force, by name.
--    public.json_bound_selftest(): the owner's check — fires each table's installed trigger with
--    a value over each limit, in a subtransaction that is rolled back.
--    public.json_bound_convert([table]): rows stored before the bound that are over it, converted
--    (never deleted): a number under 1e-18 becomes 0, a number of 1e21 or more becomes its digits
--    as a string, a value still too deep or too long becomes the "not kept" marker (code review
--    A-2). public.json_bound_check() names every such row (the first 50 of each table).
-- 4. Erasure as it is today, made unable to lose a value (reviews A-1, A-2): the soft delete's
--    rewrite becomes public.jsonb_erase_address_text — 052's jsonb_replace_text_value counting
--    keys by the text's length (052 counted them with a pattern a string beginning ": " fooled)
--    and raising where 052 put a stand-in in place of a whole document; the purge's rewrites go
--    through public.jsonb_erase_id_text, which matches the id only outside escapes (review TA-a-1:
--    a control character printed \u00XX or \f ahead of the rest of an id was matched across the
--    escape) and numbers a key that would merge with another, never dropping one. With every
--    stored value at most 128 levels deep, no erasure statement can reach the server's stack limit
--    (design 56e-3a §2.4, measured on x86_64 and arm64 at max_stack_depth = 100kB).
--
-- Needs PostgreSQL 17 (pg_column_toast_chunk_id). Locks: SHARE ROW EXCLUSIVE on each table whose
-- triggers it makes, through public.json_bound_lock — every attempt gives up within half of
-- deadlock_timeout, before any application transaction could be aborted by a deadlock, and is
-- retried for at most 30 s; then this statement fails whole, naming the busy table and who holds
-- it. Pasted again it changes nothing; after 075 it is refused by 064's order guard.
do $m074$
declare
  r record;
  refuse_md5 text;
begin
  if current_setting('server_version_num')::int < 170000 then
    raise exception '074: PostgreSQL 17 or later is required (the bound reads pg_column_toast_chunk_id); this server is %', current_setting('server_version');
  end if;
  perform set_config('lock_timeout', '5s', true);
  -- Every name below is schema-qualified; the catalogue's own names print qualified too.
  perform set_config('search_path', 'pg_catalog, pg_temp', true);

  -- ── Erasure: no value lost (reviews A-1, A-2) ───────────────────────────────────────────────
  -- Both rewrites below change only the text of strings (an id inside a string or key; an address
  -- that is a whole string or key) and read the text back as jsonb. jsonb keeps one of two equal
  -- keys of an object, so a rewrite that makes two keys equal drops a member — and only that makes
  -- the text read back print shorter than the text written: the members are reordered, never
  -- otherwise changed (no number, escape or space is touched). So each rewrite compares the two
  -- lengths: equal, nothing was lost. One print of the result, no walk (a member count over the
  -- tree took 9 s on a 13 MB trajectory: design 56e-3a §2.4).

  -- The purge's rewrite of a JSON value: every case-insensitive occurrence of the account id in a
  -- string or key becomes 'erased' — what today's statements did with regexp_replace(<col>::text,
  -- id, 'erased', 'gi')::jsonb, which silently kept one of two keys that the rewrite made equal
  -- (review A-1: {"erased": 1, "<id>": 2} lost 1), and matched an id whose first characters were
  -- the tail of an escape (review TA-a-1: "\f" or "\u0001" before the rest of an id raised, or
  -- silently changed a character). Every escape Postgres prints (\" \\ \/ \b \f \n \r \t \uXXXX)
  -- is set aside first and put back last, so only text a string really holds is matched (Postgres
  -- never escapes 0-9, a-f or '-', so an id in a string is always printed as itself). Where any key
  -- would merge, every key that holds the id is numbered in document order instead —
  -- 'erased…#<n>-<12 hex of the document's md5>' (a document cannot hold a key naming its own
  -- digest) — so no value is lost; should a merge remain, it raises (never reached in the fuzz:
  -- design 56e-3a §2.4).
  create or replace function public.jsonb_erase_id_text(doc jsonb, id text)
  returns jsonb
  language plpgsql
  immutable
  parallel safe
  set search_path = pg_catalog
  set standard_conforming_strings = on
  as $f$
  declare
    src text;
    pat text;
    esc text[];
    masked text;
    work text;
    keypat text;
    parts text[];
    keys text[];
    digest text;
    restored text;
    result jsonb;
    i int;
  begin
    if doc is null or id is null or id = '' then
      return doc;
    end if;
    src := doc::text;
    pat := '***=' || id;
    if src !~* pat then
      return doc;
    end if;
    -- The escapes, in order, each replaced by chr(5) (Postgres prints no control character raw, so
    -- chr(1)…chr(5) never occur in the text).
    esc := array(select m[1] from regexp_matches(src, '(\\(?:u[0-9a-fA-F]{4}|.))', 'g') m);
    masked := regexp_replace(src, '\\(?:u[0-9a-fA-F]{4}|.)', chr(5), 'g');
    if masked !~* pat then
      return doc;
    end if;
    work := regexp_replace(masked, pat, 'erased', 'gi');
    select string_agg(u.p || coalesce(u.e, ''), '' order by u.n) into restored
      from unnest(string_to_array(work, chr(5)), esc) with ordinality u(p, e, n);
    result := restored::jsonb;
    if octet_length(result::text) = octet_length(restored) then
      return result;
    end if;
    -- Every string marked chr(1)…chr(2): a marked string followed by ": " is a key (jsonb prints
    -- ", " or a bracket after a value). Each key holding the id is numbered, in document order.
    -- (Reached only when a key would merge; the debug line lets a test count it: reviews B-3, S7.)
    raise debug 'jsonb_erase_id_text: keys numbered';
    digest := left(md5(src), 12);
    work := regexp_replace(masked, '"[^"]*"', chr(1) || '\&' || chr(2), 'g');
    keypat := chr(1) || '"[^"' || chr(2) || ']*' || regexp_replace(id, '([^0-9A-Za-z])', '\\\1', 'g')
              || '[^"' || chr(2) || ']*"' || chr(2) || ': ';
    parts := regexp_split_to_array(work, keypat, 'i');
    keys := array(select m[1] from regexp_matches(work, '(' || keypat || ')', 'gi') m);
    work := parts[1];
    for i in 1 .. coalesce(array_length(keys, 1), 0) loop
      work := work || regexp_replace(left(keys[i], length(keys[i]) - 4), pat, 'erased', 'gi')
                   || '#' || i || '-' || digest || '"' || chr(2) || ': ' || parts[i + 1];
    end loop;
    work := regexp_replace(work, pat, 'erased', 'gi');
    work := replace(replace(work, chr(1), ''), chr(2), '');
    select string_agg(u.p || coalesce(u.e, ''), '' order by u.n) into restored
      from unnest(string_to_array(work, chr(5)), esc) with ordinality u(p, e, n);
    result := restored::jsonb;
    if octet_length(result::text) = octet_length(restored) then
      return result;
    end if;
    raise exception 'erasure: replacing an account id would merge two keys of one object even when numbered'
      using errcode = 'data_exception', hint = 'docs/runbooks/jobs.md, "An erasure refused a key collision"';
  end
  $f$;

  -- The soft delete's rewrite: 052's public.jsonb_replace_text_value with its two faults removed —
  -- keys compared by the text's length (review A-2: 052 counted keys with a pattern that a
  -- string beginning ": " fooled, and lost a value or replaced a whole document), and no stand-in:
  -- a document whose keys still collide once numbered raises instead of being replaced whole, and
  -- one that cannot be read back is an error (no stored value is deeper than 128 levels, so none
  -- is). Everything else is 052's text, unchanged. A new name: 052's own function stays as it
  -- is (the build before this one calls it; the replay re-applies 052), unused from this release.
  create or replace function public.jsonb_erase_address_text(doc jsonb, target text, replacement text)
  returns jsonb
  language plpgsql
  immutable
  parallel unsafe
  set search_path = pg_catalog
  set standard_conforming_strings = on
  as $f$
  declare
    src text collate "C";
    enc text collate "C";
    rep text collate "C";
    work text collate "C";
    done text collate "C";
    out_text text;
    plain text collate "C";
    result jsonb;
    parts text[];
    suffix text;
    attempt int;
  begin
    if doc is null or target is null then
      return doc;
    end if;
    -- Case is folded for ASCII A–Z only, on every server (review A-4, RA2-10): the text is compared
    -- in the "C" collation, the platform's own rule for addresses (storedEmail).
    src := doc::text collate "C";
    enc := to_jsonb(target)::text;
    if not (src ~* ('***=' || substr(enc, 2, length(enc) - 2))) then
      return doc;
    end if;
    rep := to_jsonb(coalesce(replacement, ''))::text;
    work := replace(replace(src, '\\', chr(3)), '\"', chr(4)) collate "C";
    enc := replace(replace(enc, '\\', chr(3)), '\"', chr(4));
    rep := replace(replace(rep, '\\', chr(3)), '\"', chr(4));
    plain := work collate "C";
    if substr(enc, 2, length(enc) - 2)
         ~ ('[!#$%&''()*/;<=>?@\\^_`|~bcdghijkmopqvwxyzBCDGHIJKMOPQVWXYZ' || chr(3) || chr(4) || ']') then
      done := regexp_replace(work, '***=' || enc, rep, 'gi');
    else
      work := regexp_replace(work, '"[^"]*"', chr(1) || '\&' || chr(2), 'g');
      done := regexp_replace(work, '***=' || chr(1) || enc || chr(2), chr(1) || rep || chr(2), 'gi');
      if done = work then
        return doc;
      end if;
      done := replace(replace(done, chr(1), ''), chr(2), '');
    end if;
    if done = work then
      return doc;
    end if;
    out_text := replace(replace(done, chr(4), '\"'), chr(3), '\\');
    result := out_text::jsonb;
    if octet_length(result::text) = octet_length(out_text) then
      return result;
    end if;
    -- (Reached only when a key would merge; the debug line lets a test count it: reviews B-3, S7.)
    raise debug 'jsonb_erase_address_text: keys numbered';
    work := regexp_replace(plain, '"[^"]*"', chr(1) || '\&' || chr(2), 'g');
    parts := regexp_split_to_array(work, '***=' || chr(1) || enc || chr(2) || ': ', 'i');
    for attempt in 1..2 loop
      suffix := case when attempt = 1 then '' else '-' || left(md5(src), 12) end;
      select string_agg(
               case when t.n = 1 then t.p
                    else chr(1) || substr(rep, 1, length(rep) - 1) || '#' || (t.n - 1)::text
                         || suffix || '"' || chr(2) || ': ' || t.p
               end, '' order by t.n)
        into done
        from unnest(parts) with ordinality as t(p, n);
      done := regexp_replace(done, '***=' || chr(1) || enc || chr(2), chr(1) || rep || chr(2), 'gi');
      done := replace(replace(done, chr(1), ''), chr(2), '');
      out_text := replace(replace(done, chr(4), '\"'), chr(3), '\\');
      result := out_text::jsonb;
      if octet_length(result::text) = octet_length(out_text) then
        return result;
      end if;
    end loop;
    raise exception 'erasure: replacing an address would merge two keys of one object even when numbered'
      using errcode = 'data_exception', hint = 'docs/runbooks/jobs.md, "An erasure refused a key collision"';
  end
  $f$;

  -- ── The bound ────────────────────────────────────────────────────────────────────────────────
  -- The one place the bound's depth is written: the path that finds a container nested deeper
  -- than 128 levels (a container at level 128 under the root is the 129th), as Postgres prints it.
  create or replace function public.json_bound_depth_path()
  returns jsonpath
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $f$
    select 'strict $.**{128}?(@.type() == "object" || @.type() == "array")'::pg_catalog.jsonpath
  $f$;

  -- The one place the bound's number rule is written: the path that finds a number other than 0 or
  -- 1e-18 <= |n| < 1e21. Inside that range a number prints as JavaScript's JSON.stringify writes it
  -- or at most 4 x as long (1e-18 prints 0.000000000000000001), so every document the application
  -- may store (1 MiB of compact JSON) prints at most 4 MiB; outside it, a number of a few stored
  -- bytes can print 100 000 characters (docs/JSON_BOUND.md §3). A string is never a
  -- number here (.abs() of a string is an error, and an error in a filter is false).
  create or replace function public.json_bound_number_path()
  returns jsonpath
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $f$
    select 'strict $.**?(@.abs() >= 1e21 || @.abs() < 1e-18)?(@ != 0)'::pg_catalog.jsonpath
  $f$;

  -- The one place the bound's size is written: a jsonb value of `col` in `rel` may print at most
  -- this many bytes of text (0: bounded in depth only). 8 MiB everywhere (docs/JSON_BOUND.md §1: the most an
  -- application-written value can reach, 1 MiB compact printed <= 4 MiB, grown by today's soft
  -- delete <= 7.5 MiB, fits), except agent_trajectories.steps — a whole run, depth only — until
  -- migration 076 makes the steps rows and replaces this function without the exception.
  create or replace function public.json_bound_limit(rel regclass, col name)
  returns bigint
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $f$
    select case when rel = 'public.agent_trajectories'::pg_catalog.regclass and col = 'steps' then 0::bigint
                else 8388608::bigint end
  $f$;

  -- The bound's test of one value, as SQL text over the expression `v` (the trigger's new.<col>,
  -- or the column itself in json_bound_check — one text for both, so the check of existing rows is
  -- the triggers' own test: review SB-14). Cheapest first; OR stops at the first true term, so the
  -- text is printed only for a value whose size as stored, depth and numbers have passed:
  --   pg_column_size(v || '[]') — the value's size decompressed (a stored value copied from another
  --   table is decompressed by ||; an array is returned as it is, so this costs nothing in memory),
  --   over 4 x lim + 64 KiB: certainly longer than lim as text.
  create or replace function public.json_bound_term(v text, lim bigint)
  returns text
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $f$
    select case when lim = 0
                then format('jsonb_path_exists(%1$s, %2$L::jsonpath)', v, public.json_bound_depth_path()::text)
                else format('((pg_column_size((%1$s || ''[]''::jsonb)) > %2$s) OR jsonb_path_exists(%1$s, %3$L::jsonpath) OR jsonb_path_exists(%1$s, %4$L::jsonpath) OR (octet_length((%1$s)::text) > %5$s))',
                            v, 4 * lim + 65536, public.json_bound_depth_path()::text,
                            public.json_bound_number_path()::text, lim) end
  $f$;

  -- Why a value is over the bound (null: it is within it) — the words of the refusal, the same
  -- tests in the same order as json_bound_term.
  create or replace function public.json_bound_reason(v jsonb, lim bigint)
  returns text
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $f$
    select case when v is null then null
                when lim > 0 and pg_column_size(v || '[]'::jsonb) > 4 * lim + 65536
                  then format('it is %s bytes as stored, so longer than %s bytes as text', pg_column_size(v || '[]'::jsonb), lim)
                when jsonb_path_exists(v, public.json_bound_depth_path()) then 'it is nested deeper than 128 levels'
                when lim > 0 and jsonb_path_exists(v, public.json_bound_number_path())
                  then 'it holds a number other than 0 or 1e-18 <= |n| < 1e21'
                when lim > 0 and octet_length(v::text) > lim then format('it is longer than %s bytes as text', lim)
           end
  $f$;

  -- Raises only: the WHEN of the trigger that calls it has already found a value over the bound.
  -- Its arguments are the table's jsonb columns and each one's text limit (0: depth only), as
  -- json_bound_ddl wrote them, so the message names the column and the reason. A definer, so the
  -- writer needs no EXECUTE on json_bound_reason to be told why (review B-7: no role needs a grant
  -- of ours to write — or to be refused with check_violation rather than a permission error).
  create or replace function public.json_bound_refuse()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    i int := 0;
    v jsonb;
    was jsonb;
    over text := null;
    why text := null;
    w text;
  begin
    -- The first column over the bound that this write changed. On UPDATE a column whose old value
    -- was already over the bound and equals the new one is passed over (a row stored before the
    -- bound: code review A-19) unless no other column explains the refusal.
    while i + 1 < tg_nargs loop
      execute format('select ($1).%I', tg_argv[i]) into v using new;
      w := public.json_bound_reason(v, tg_argv[i + 1]::bigint);
      if w is not null then
        if tg_op = 'UPDATE' then
          execute format('select ($1).%I', tg_argv[i]) into was using old;
        end if;
        if tg_op <> 'UPDATE' or v is distinct from was
           or public.json_bound_reason(was, tg_argv[i + 1]::bigint) is null then
          over := tg_argv[i];
          why := w;
          exit;
        end if;
        if over is null then
          over := tg_argv[i];
          why := w;
        end if;
      end if;
      i := i + 2;
    end loop;
    raise exception '%.%: a JSON value over the bound is refused: % (migration 074; the bound: 128 levels, numbers 0 or 1e-18 <= |n| < 1e21, 8388608 bytes as text)',
        tg_table_name, coalesce(over, '(a jsonb column)'), coalesce(why, 'over the bound')
      using errcode = 'check_violation', constraint = 'json_bound', table = tg_table_name,
            column = coalesce(over, '');
  end
  $f$;

  -- The two trigger definitions of a table, exactly as pg_get_triggerdef prints them under
  -- search_path pg_catalog (readiness compares the two), or null for a table without jsonb columns.
  create or replace function public.json_bound_ddl(rel regclass)
  returns text[]
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    a record;
    ins text := '';
    upd text := '';
    args text := '';
    n int := 0;
    lim bigint;
    term text;
    chg text;
  begin
    for a in
      select att.attname
        from pg_catalog.pg_attribute att
       where att.attrelid = rel and att.attnum > 0 and not att.attisdropped
         and att.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
       order by att.attnum
    loop
      n := n + 1;
      lim := public.json_bound_limit(rel, a.attname);
      term := public.json_bound_term('new.' || quote_ident(a.attname), lim);
      -- "Unchanged" is only: the same stored toast pointer as the old value. A value held in line
      -- (or just built) is always tested: jsonb equality compares numbers by value, so 0 equals
      -- 0e-16383 and a row of plain zeros could be updated to zeros that print 16 385 characters
      -- each without any test (code review A-1).
      chg := format('((pg_column_toast_chunk_id(new.%1$s) IS DISTINCT FROM pg_column_toast_chunk_id(old.%1$s)) OR (pg_column_toast_chunk_id(new.%1$s) IS NULL))',
                    quote_ident(a.attname));
      ins := ins || case when n = 1 then '' else ' OR ' end
                 || format('((new.%1$s IS NOT NULL) AND %2$s)', quote_ident(a.attname), term);
      upd := upd || case when n = 1 then '' else ' OR ' end
                 || format('((new.%1$s IS NOT NULL) AND %2$s AND %3$s)', quote_ident(a.attname), chg, term);
      args := args || case when n = 1 then '' else ', ' end || format('%L, %L', a.attname, lim::text);
    end loop;
    if n = 0 then
      return null;
    end if;
    if n > 1 then
      ins := '(' || ins || ')';
      upd := '(' || upd || ')';
    end if;
    return array[
      format('CREATE TRIGGER zz_json_bound_ins BEFORE INSERT ON %s FOR EACH ROW WHEN (%s) EXECUTE FUNCTION public.json_bound_refuse(%s)', rel::text, ins, args),
      format('CREATE TRIGGER zz_json_bound_upd BEFORE UPDATE ON %s FOR EACH ROW WHEN (%s) EXECUTE FUNCTION public.json_bound_refuse(%s)', rel::text, upd, args)];
  end
  $f$;

  -- The tables the bound covers: every plain or partitioned table in public with a jsonb column,
  -- except a partition (its parent's triggers are cloned to it).
  create or replace function public.json_bound_tables()
  returns setof regclass
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $f$
    select c.oid::pg_catalog.regclass
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       and exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                      and a.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype)
     order by c.relname
  $f$;

  -- The mark a table's insert trigger carries once json_bound_check() has read its rows: it names
  -- the catalogue versions (oid, xmin and ctid) of both triggers — of the table and of every
  -- partition under it — which every CREATE OR REPLACE, ENABLE and DISABLE changes: each writes a
  -- new row version, under another transaction (xmin) or, in the same one, at another place
  -- (ctid: code review A-21 — the place of a version this transaction itself replaced is not
  -- given out again before it ends). So rows written while the
  -- bound was switched off and on again are "not checked" (review TA-a-3), and so are the rows a
  -- table brings with it when it is attached as a partition (its triggers are new clones: code
  -- review A-5). A comment does not change them.
  create or replace function public.json_bound_mark(rel regclass)
  returns text
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $f$
    select 'json bound: rows checked (triggers ' || string_agg(g.oid::text || ':' || g.xmin::text || ':' || g.ctid::text, ',' order by g.tgrelid, g.tgname) || ')'
      from pg_catalog.pg_trigger g
     where (g.tgrelid = rel or g.tgrelid in (select t.relid from pg_catalog.pg_partition_tree(rel) t))
       and g.tgname in ('zz_json_bound_ins', 'zz_json_bound_upd')
  $f$;

  -- Take the SHARE ROW EXCLUSIVE lock (or, for a migration that changes a table's columns, the
  -- ACCESS EXCLUSIVE one) of every table in `tables`, in their order, for the caller's transaction,
  -- never aborting an application's transaction (review B-2). One attempt takes the tables one
  -- after another within ONE budget — half of deadlock_timeout (at most 100 ms) from the attempt's
  -- start, each table's lock_timeout being what is left of it (review TA-a-2: a budget per table
  -- let an attempt that met several slow tables hold its first locks past deadlock_timeout, the
  -- moment a waiting application transaction checks for a deadlock). So no application
  -- transaction ever waits on a lock of ours longer than half of deadlock_timeout, and whenever it
  -- and this wait for each other it is this that gives up first. Giving up releases every lock the
  -- attempt took (it is a subtransaction) and tries again after 50–200 ms, for at most 30 s; then
  -- it fails, naming the table and the sessions holding it. Returns the attempts that found a
  -- table busy. Busy tables are best taken one per call (json_bound_install/off take a list).
  create or replace function public.json_bound_lock(tables regclass[], lock_mode text default 'SHARE ROW EXCLUSIVE')
  returns int
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    t regclass;
    busy regclass;
    attempts int := 0;
    started timestamptz := clock_timestamp();
    budget interval := least(interval '100 ms', greatest(interval '2 ms', current_setting('deadlock_timeout')::interval / 2));
    attempt_end timestamptz;
    left_ms int;
  begin
    if lock_mode not in ('SHARE ROW EXCLUSIVE', 'ACCESS EXCLUSIVE') then
      raise exception 'json_bound_lock: lock mode % is not one this helper takes', lock_mode;
    end if;
    loop
      begin
        attempt_end := clock_timestamp() + budget;
        foreach t in array tables loop
          busy := t;
          left_ms := greatest(1, floor(extract(epoch from attempt_end - clock_timestamp()) * 1000)::int);
          perform set_config('lock_timeout', left_ms || 'ms', true);
          execute format('LOCK TABLE %s IN %s MODE', t, lock_mode);
          if clock_timestamp() > attempt_end then
            raise exception using errcode = 'lock_not_available';
          end if;
        end loop;
        perform set_config('lock_timeout', '5s', true);
        return attempts;
      exception when lock_not_available then
        attempts := attempts + 1;
        if clock_timestamp() - started > interval '30 seconds' then
          raise exception 'json bound: % stayed busy for 30 s (% attempts); nothing was changed. Holding it: %', busy, attempts,
            coalesce((select string_agg(format('pid %s (%s, %s, transaction open %s)', l.pid, coalesce(a.backend_type, '?'),
                                               coalesce(a.state, '?'),
                                               coalesce(date_trunc('second', clock_timestamp() - a.xact_start)::text, '?')), '; ')
                        from pg_catalog.pg_locks l left join pg_catalog.pg_stat_activity a on a.pid = l.pid
                       where l.relation = busy and l.granted and l.pid <> pg_catalog.pg_backend_pid()), 'no session found')
            using errcode = 'lock_not_available',
                  hint = 'docs/MIGRATION_v5_to_v6.md, "The JSON bound could not take its locks": if this was migration 074 itself, nothing of it exists yet — paste 074 again in a quieter minute. If it was json_bound_install or json_bound_off, run it for that one table when it is quieter: select public.json_bound_install(array[''<table>''::regclass])';
        end if;
        perform pg_catalog.pg_sleep(0.05 + random() * 0.15);
      end;
    end loop;
  end
  $f$;

  -- Install or repair: (re)make and enable ALWAYS the triggers of each covered table — or of each
  -- table in `only_tables` — whose triggers are not exactly as json_bound_ddl writes them and
  -- enabled ALWAYS. A table it touched is "rows not checked" until json_bound_check() reads it.
  -- Locks: json_bound_lock, only on the tables it repairs; a run with nothing to repair locks
  -- nothing. One table per call is the form for a busy database (review TB-a-2). Returns what it
  -- did, as one line. The tables' owner only.
  -- A partitioned table is repaired through its root (the partitions' triggers are its clones):
  -- a partition whose clone is not in force makes its root one to repair (code review A-5).
  -- TRIGGER on every table it covers (given tables: on those) is taken away from anon,
  -- authenticated and service_role, whether or not the triggers needed repair: a role holding it
  -- can replace a trigger of the bound with its own (code review A-7; Supabase's default
  -- privileges grant it). REVOKE takes no lock on the table.
  create or replace function public.json_bound_install(only_tables regclass[] default null)
  returns text
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    t regclass;
    todo regclass[] := '{}';
    want text[];
    have text;
    ok boolean;
    total int := 0;
    busy int;
    leaf regclass;
    role_name text;
  begin
    if only_tables is not null and exists (select 1 from unnest(only_tables) u(t)
                                            where u.t not in (select x from public.json_bound_tables() x)) then
      raise exception 'json_bound_install: % is not a table the bound covers (a table in public with a jsonb column)',
        (select string_agg(u.t::text, ', ') from unnest(only_tables) u(t) where u.t not in (select x from public.json_bound_tables() x));
    end if;
    for t in select x from public.json_bound_tables() x where only_tables is null or x = any (only_tables) loop
      total := total + 1;
      ok := true;
      for leaf in select t union select p.relid from pg_catalog.pg_partition_tree(t) p loop
        want := public.json_bound_ddl(leaf);
        if (select count(*) from pg_catalog.pg_trigger g
             where g.tgrelid = leaf and g.tgname in ('zz_json_bound_ins', 'zz_json_bound_upd')) <> 2 then
          ok := false;
        end if;
        for have in
          select (case when g.tgname = 'zz_json_bound_ins' then '1' else '2' end) || '|' || g.tgenabled::text || '|' || pg_catalog.pg_get_triggerdef(g.oid)
            from pg_catalog.pg_trigger g
           where g.tgrelid = leaf and g.tgname in ('zz_json_bound_ins', 'zz_json_bound_upd')
        loop
          if have not in ('1|A|' || want[1], '2|A|' || want[2]) then ok := false; end if;
        end loop;
      end loop;
      if not ok then todo := todo || t; end if;
      for role_name in select x.r from (values ('anon'), ('authenticated'), ('service_role')) x(r)
                        where pg_catalog.to_regrole(x.r) is not null
                          and pg_catalog.has_table_privilege(x.r, t, 'TRIGGER') loop
        execute format('REVOKE TRIGGER ON TABLE %s FROM %I', t, role_name);
      end loop;
    end loop;
    if cardinality(todo) = 0 then
      return format('json bound: %s tables covered, 0 (re)made', total);
    end if;
    busy := public.json_bound_lock(todo);
    foreach t in array todo loop
      want := public.json_bound_ddl(t);
      execute replace(want[1], 'CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER');
      execute replace(want[2], 'CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER');
      execute format('ALTER TABLE %s ENABLE ALWAYS TRIGGER zz_json_bound_ins', t);
      execute format('ALTER TABLE %s ENABLE ALWAYS TRIGGER zz_json_bound_upd', t);
      execute format('COMMENT ON TRIGGER zz_json_bound_ins ON %s IS %L', t, 'json bound: rows not checked');
      -- This server prints the definitions as json_bound_ddl writes them, or the install fails here
      -- (and readiness could never agree with it).
      for leaf in select t union select p.relid from pg_catalog.pg_partition_tree(t) p loop
        want := public.json_bound_ddl(leaf);
        if (select count(*) from pg_catalog.pg_trigger g
             where g.tgrelid = leaf and g.tgname in ('zz_json_bound_ins', 'zz_json_bound_upd') and g.tgenabled = 'A'
               and pg_catalog.pg_get_triggerdef(g.oid) in (want[1], want[2])) <> 2 then
          raise exception 'json_bound_install: % — this server prints the trigger otherwise than json_bound_ddl writes it, or did not enable it', leaf;
        end if;
      end loop;
    end loop;
    return format('json bound: %s tables covered, %s (re)made (%s busy attempts): %s; now run select public.json_bound_check(); (or, table by table, select public.json_bound_check(''<table>'');)',
                  total, cardinality(todo), busy, array_to_string(todo, ', '));
  end
  $f$;

  -- The emergency off (writes refused or slowed by the bound): both triggers of every covered table
  -- — or of each table in `only_tables`, one table per call being the form for a busy database
  -- (review TB-a-2) — disabled, under json_bound_lock. Readiness reports "the bound is off" for
  -- each such table until json_bound_install() (then json_bound_check()) puts it back. The tables'
  -- owner only.
  create or replace function public.json_bound_off(only_tables regclass[] default null)
  returns text
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    t regclass;
    todo regclass[];
    busy int;
  begin
    -- Tables the bound covers (public only), each once however often it is named (code review A-16).
    todo := array(select x from public.json_bound_tables() x
                   where (only_tables is null or x = any (only_tables))
                     and exists (select 1 from pg_catalog.pg_trigger g
                                  where g.tgrelid = x and g.tgname = 'zz_json_bound_ins' and not g.tgisinternal and g.tgparentid = 0)
                   order by x::text);
    if only_tables is not null and exists (select 1 from unnest(only_tables) u(t) where u.t <> all (todo)) then
      raise exception 'json_bound_off: % carries no bound trigger (a table in public that the bound covers is meant)',
        (select string_agg(distinct u.t::text, ', ') from unnest(only_tables) u(t) where u.t <> all (todo));
    end if;
    busy := public.json_bound_lock(todo);
    foreach t in array todo loop
      execute format('ALTER TABLE %s DISABLE TRIGGER zz_json_bound_ins', t);
      execute format('ALTER TABLE %s DISABLE TRIGGER zz_json_bound_upd', t);
    end loop;
    return format('json bound: OFF on %s tables (%s busy attempts): %s; restore with select public.json_bound_install(); then select public.json_bound_check(); (busy: one table per call)',
                  cardinality(todo), busy, array_to_string(todo, ', '));
  end
  $f$;

  -- Read every row of every covered table (or of `only_rel`) and refuse — naming table, column,
  -- the reason and the row (its primary key when made of uuids and integers; otherwise its ctid,
  -- the key withheld: reviews A-9, B-10) — if any value is over the bound. Every such row is named,
  -- the first 50 of each table and the count of the rest, in one refusal (code review A-2: one row
  -- per run cost one full read per row). The test is json_bound_term, the triggers' own.
  -- Marks each table read clean with json_bound_mark. One scan per table (each leaf of a
  -- partitioned one, once: RA2-13). Needs a role that sees every row (superuser or BYPASSRLS:
  -- review B-9). Returns what it read, as one line.
  create or replace function public.json_bound_check(only_rel regclass default null)
  returns text
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    t regclass;
    leaf regclass;
    a record;
    pred text;
    pick text;
    keycol text;
    sql text;
    hit record;
    tables int := 0;
    n bigint;
    over_rows bigint := 0;
    found text := '';
    state text;
    msg text;
  begin
    if not (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) then
      raise exception 'json_bound_check: % cannot see every row (row-level security); run it as the tables'' owner with BYPASSRLS, as postgres on Supabase', current_user;
    end if;
    perform set_config('row_security', 'off', true);
    perform set_config('lock_timeout', '5s', true);
    for t in select x from public.json_bound_tables() x where only_rel is null or x = only_rel loop
      if (select count(*) from pg_catalog.pg_trigger g
           where g.tgrelid = t and g.tgname in ('zz_json_bound_ins', 'zz_json_bound_upd')) <> 2 then
        raise exception 'json_bound_check: % does not carry the bound''s two triggers; run select public.json_bound_install(array[''%''::regclass]); first, then this again', t, t
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      for leaf in
        select c.oid::pg_catalog.regclass from pg_catalog.pg_class c
         where c.relkind = 'r' and (c.oid = t or c.oid in (select relid from pg_catalog.pg_partition_tree(t)))
      loop
        pred := '';
        pick := '';
        keycol := null;
        for a in
          select att.attname, public.json_bound_limit(t, att.attname) as lim
            from pg_catalog.pg_attribute att
           where att.attrelid = leaf and att.attnum > 0 and not att.attisdropped
             and att.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
           order by att.attnum
        loop
          pred := pred || case when pred = '' then '' else ' or ' end
                  || format('(%1$I is not null and %2$s)', a.attname, public.json_bound_term(quote_ident(a.attname), a.lim));
          pick := pick || format(' when (%1$I is not null and %2$s) then %3$L || '': '' || public.json_bound_reason(%1$I, %4$s)',
                                 a.attname, public.json_bound_term(quote_ident(a.attname), a.lim), a.attname, a.lim);
        end loop;
        -- The primary key, when every column of it is a uuid or an integer (never personal data);
        -- otherwise the ctid, the key withheld.
        select case when bool_and(att.atttypid in ('pg_catalog.uuid'::pg_catalog.regtype, 'pg_catalog.int4'::pg_catalog.regtype,
                                                   'pg_catalog.int8'::pg_catalog.regtype))
                    then string_agg(format('%I::text', att.attname), ' || '', '' || ' order by k.n) end
          into keycol
          from pg_catalog.pg_index i
          cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum, n)
          join pg_catalog.pg_attribute att on att.attrelid = i.indrelid and att.attnum = k.attnum
         where i.indrelid = leaf and i.indisprimary;
        sql := format('select case%s end as col, %s as k, count(*) over () as n from only %s where %s limit 50',
                      pick,
                      case when keycol is null then 'ctid::text || '' (key withheld)''' else '''('' || ' || keycol || ' || '')''' end,
                      leaf, pred);
        n := 0;
        begin
          for hit in execute sql loop
            n := hit.n;
            found := found || format(E'\n  %s.%s — row %s', leaf, hit.col, hit.k);
          end loop;
        exception when others then
          -- A stored value that cannot be read at all (one that prints past PostgreSQL's 1 GB
          -- limit, a lock not given in 5 s): the table is named, never left to the server's bare
          -- message (code review A-17).
          get stacked diagnostics state = returned_sqlstate, msg = message_text;
          raise exception 'json_bound_check: % — its rows could not be read (%: %)', leaf, state, msg
            using errcode = state,
                  hint = 'docs/MIGRATION_v5_to_v6.md, "A row over the JSON bound": the largest stored values of a table are found with select ctid, pg_column_size(<column>) from only <table> order by 2 desc limit 5';
        end;
        if n > 50 then
          found := found || format(E'\n  %s — and %s more rows', leaf, n - 50);
        end if;
        over_rows := over_rows + n;
      end loop;
      execute format('COMMENT ON TRIGGER zz_json_bound_ins ON %s IS %L', t, public.json_bound_mark(t));
      tables := tables + 1;
    end loop;
    if over_rows > 0 then
      raise exception 'json_bound_check: % row(s) over the bound (the first 50 of each table are named):%', over_rows, found
        using errcode = 'check_violation',
              hint = 'docs/MIGRATION_v5_to_v6.md, "A row over the JSON bound": select public.json_bound_convert(); converts them (it never deletes a row), then run this again';
    end if;
    return format('json bound: %s tables read, every row within the bound', tables);
  end
  $f$;

  -- Convert the rows the bound would refuse (stored before it, or while it was off) — every covered
  -- table, or `only_rel` — so that every later write of them, an erasure's rewrite included, is
  -- accepted (code review A-2: an erasure that must rewrite such a row is refused with 23514
  -- json_bound until it is converted). It converts, it never deletes a row or a member:
  --   a number under 1e-18 in magnitude (not 0) becomes 0;
  --   a number of 1e21 or more in magnitude becomes its digits as a string (no digit is lost);
  --   a value that is then still over the bound — nested deeper than 128 levels, or longer than
  --     8 MiB as text — becomes the "not kept" marker the application already reads,
  --     {"_omitted": {"code": "request.json_too_deep" | "request.json_too_large"}}.
  -- The numbers are found by a walk over the value's members (a recursive query: no stack, and
  -- only for a value at most 128 levels deep), each replaced in place with jsonb_set; no text of
  -- the value is rewritten. Each row is changed in its own subtransaction: one that another rule
  -- of its table refuses is named with that rule's SQLSTATE and left as it was (nothing is
  -- forced). The bound's own triggers test every converted value like any write. One line per
  -- table that had such rows, then a total. The tables' owner only; needs a role that sees every row.
  create or replace function public.json_bound_convert(only_rel regclass default null)
  returns setof text
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    t regclass;
    leaf regclass;
    r record;
    fix record;
    cols name[];
    lims bigint[];
    vals jsonb[];
    val jsonb;
    i int;
    sets text;
    pred text;
    keycol text;
    state text;
    row_numbers int;
    row_markers int;
    in_numbers bigint;
    as_marker bigint;
    converted bigint;
    refused bigint;
    total bigint := 0;
    total_refused bigint := 0;
  begin
    if not (select x.rolsuper or x.rolbypassrls from pg_catalog.pg_roles x where x.rolname = current_user) then
      raise exception 'json_bound_convert: % cannot see every row (row-level security); run it as the tables'' owner with BYPASSRLS, as postgres on Supabase', current_user;
    end if;
    perform set_config('row_security', 'off', true);
    for t in select x from public.json_bound_tables() x where only_rel is null or x = only_rel loop
      for leaf in
        select c.oid::pg_catalog.regclass from pg_catalog.pg_class c
         where c.relkind = 'r' and (c.oid = t or c.oid in (select relid from pg_catalog.pg_partition_tree(t)))
      loop
        select array_agg(att.attname order by att.attnum), array_agg(public.json_bound_limit(t, att.attname) order by att.attnum),
               string_agg(format('(%1$I is not null and %2$s)', att.attname,
                                 public.json_bound_term(quote_ident(att.attname), public.json_bound_limit(t, att.attname))), ' or ' order by att.attnum)
          into cols, lims, pred
          from pg_catalog.pg_attribute att
         where att.attrelid = leaf and att.attnum > 0 and not att.attisdropped
           and att.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype;
        select case when bool_and(att.atttypid in ('pg_catalog.uuid'::pg_catalog.regtype, 'pg_catalog.int4'::pg_catalog.regtype,
                                                   'pg_catalog.int8'::pg_catalog.regtype))
                    then string_agg(format('%I::text', att.attname), ' || '', '' || ' order by k.n) end
          into keycol
          from pg_catalog.pg_index ix
          cross join lateral unnest(ix.indkey::int2[]) with ordinality k(attnum, n)
          join pg_catalog.pg_attribute att on att.attrelid = ix.indrelid and att.attnum = k.attnum
         where ix.indrelid = leaf and ix.indisprimary;
        in_numbers := 0;
        as_marker := 0;
        converted := 0;
        refused := 0;
        -- Every jsonb column of a row that is over the bound is converted in ONE update of the
        -- row: the bound tests each value held in line on every update of its row.
        for r in execute format('select ctid as rid, array[%s]::jsonb[] as vals, %s as k from only %s where %s',
                                (select string_agg(quote_ident(c), ', ' order by o) from unnest(cols) with ordinality u(c, o)),
                                case when keycol is null then 'ctid::text || '' (key withheld)''' else '''('' || ' || keycol || ' || '')''' end,
                                leaf, pred)
        loop
          vals := r.vals;
          sets := '';
          row_numbers := 0;
          row_markers := 0;
          for i in 1 .. cardinality(cols) loop
            val := vals[i];
            if val is null or public.json_bound_reason(val, lims[i]) is null then
              continue;
            end if;
            if lims[i] > 0 and pg_column_size(val || '[]'::jsonb) <= 4 * lims[i] + 65536
               and not jsonb_path_exists(val, public.json_bound_depth_path())
               and jsonb_path_exists(val, public.json_bound_number_path()) then
              if jsonb_typeof(val) = 'number' then
                val := case when abs(val::numeric) < 1e-18 then '0'::jsonb else to_jsonb(val::numeric::text) end;
              else
                for fix in
                  with recursive w(path, node) as (
                    select '{}'::text[], val
                    union all
                    select w.path || m.k, m.node
                      from w
                      cross join lateral (
                        select e.key, e.value
                          from jsonb_each(case when jsonb_typeof(w.node) = 'object' then w.node else '{}'::jsonb end) e
                        union all
                        select (e.n - 1)::text, e.value
                          from jsonb_array_elements(case when jsonb_typeof(w.node) = 'array' then w.node else '[]'::jsonb end)
                               with ordinality e(value, n)
                      ) m(k, node)
                  )
                  select q.path, q.num
                    from (select w.path, case when jsonb_typeof(w.node) = 'number' then w.node::numeric end as num from w) q
                   where q.num <> 0 and (abs(q.num) >= 1e21 or abs(q.num) < 1e-18)
                loop
                  val := jsonb_set(val, fix.path,
                                   case when abs(fix.num) < 1e-18 then '0'::jsonb else to_jsonb(fix.num::text) end, false);
                end loop;
              end if;
            end if;
            if public.json_bound_reason(val, lims[i]) is null then
              row_numbers := row_numbers + 1;
            else
              row_markers := row_markers + 1;
              val := jsonb_build_object('_omitted', jsonb_build_object('code',
                       case when jsonb_path_exists(vals[i], public.json_bound_depth_path()) then 'request.json_too_deep'
                            else 'request.json_too_large' end));
            end if;
            vals[i] := val;
            sets := sets || case when sets = '' then '' else ', ' end || format('%I = ($1)[%s]', cols[i], i);
          end loop;
          begin
            execute format('update only %s set %s where ctid = $2', leaf, sets) using vals, r.rid;
            converted := converted + 1;
            in_numbers := in_numbers + row_numbers;
            as_marker := as_marker + row_markers;
          exception when others then
            get stacked diagnostics state = returned_sqlstate;
            refused := refused + 1;
            return next format('%s: row %s NOT converted — another rule of this table refuses the change (SQLSTATE %s); it is left as it was and needs a decision (docs/MIGRATION_v5_to_v6.md, "A row over the JSON bound")',
                               leaf, r.k, state);
          end;
        end loop;
        if converted + refused > 0 then
          return next format('%s: %s row(s) converted (%s value(s) in their numbers, %s replaced by the "not kept" marker), %s row(s) not converted',
                             leaf, converted, in_numbers, as_marker, refused);
        end if;
        total := total + converted;
        total_refused := total_refused + refused;
      end loop;
    end loop;
    return next format('json bound: %s row(s) converted, %s not converted; now run select public.json_bound_check();', total, total_refused);
  end
  $f$;

  -- The owner's check that the INSTALLED triggers refuse (reviews TA-a-5, TB-a-4): for every
  -- covered table, its first jsonb column with a size limit (else its first) gets, one at a time,
  -- a value nested 129 deep, a value holding 1e-30 and a value one byte longer than its limit as
  -- text, each INSERTed in a subtransaction that is always rolled back — nothing is written. One
  -- row per table and value: 'refused' (the bound's check_violation). Where another BEFORE trigger
  -- of the table stops such a bare insert first (agent_trajectory_steps: its guard needs a real
  -- trajectory), the installed trigger's own WHEN — read from the catalogue as installed — is
  -- evaluated on the value instead: 'refused (installed WHEN; insert stopped by <sqlstate>)'.
  -- Anything else is named, never hidden. The tables' owner only; read-only in effect.
  create or replace function public.json_bound_selftest()
  returns table (tbl text, col text, probe text, outcome text)
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $f$
  declare
    t regclass;
    lim bigint;
    v jsonb;
    big jsonb;
    cname text;
    state text;
  begin
    perform set_config('row_security', 'off', true);
    big := (select jsonb_agg(left(repeat(md5(g::text), 4), 100)) from generate_series(1, 80659) g)
           || pg_catalog.to_jsonb(repeat('y', 69));                       -- 8 388 609 bytes as text
    for t in select x from public.json_bound_tables() x loop
      tbl := t::text;
      select att.attname, public.json_bound_limit(t, att.attname) into col, lim
        from pg_catalog.pg_attribute att
       where att.attrelid = t and att.attnum > 0 and not att.attisdropped
         and att.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
       order by public.json_bound_limit(t, att.attname) = 0, att.attnum
       limit 1;
      foreach probe in array case when lim = 0 then array['depth 129'] else array['depth 129', 'number 1e-30', 'text limit + 1'] end loop
        v := case probe when 'depth 129' then (repeat('[', 129) || repeat(']', 129))::jsonb
                        when 'number 1e-30' then '[1e-30]'::jsonb
                        else big end;
        begin
          execute format('insert into %s (%I) values ($1)', t, col) using v;
          outcome := 'NOT REFUSED';
          raise exception using errcode = 'P0004';                     -- roll the row back
        exception
          when check_violation then
            get stacked diagnostics cname = constraint_name;
            outcome := case when cname = 'json_bound' then 'refused' else 'stopped before the bound: check_violation ' || cname end;
          when sqlstate 'P0004' then
            null;
          when others then
            get stacked diagnostics state = returned_sqlstate;
            outcome := 'stopped before the bound: ' || state;
        end;
        if outcome like 'stopped before the bound: %' then
          -- The installed WHEN of zz_json_bound_ins, on a row whose jsonb columns are null but this one.
          select substring(pg_catalog.pg_get_triggerdef(g.oid) from ' WHEN \((.*)\) EXECUTE FUNCTION ')
            into cname
            from pg_catalog.pg_trigger g where g.tgrelid = t and g.tgname = 'zz_json_bound_ins' and g.tgenabled = 'A';
          if cname is not null then
            execute format('select %s from (select %s) new', cname,
                           (select string_agg(case when att.attname = col then '$1 as ' else 'null::jsonb as ' end || quote_ident(att.attname), ', ' order by att.attnum)
                              from pg_catalog.pg_attribute att
                             where att.attrelid = t and att.attnum > 0 and not att.attisdropped
                               and att.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype))
              into state using v;
            outcome := case when state::boolean then 'refused (installed WHEN; insert stopped by ' || substr(outcome, 27) || ')'
                            else 'NOT REFUSED by the installed WHEN' end;
          end if;
        end if;
        return next;
      end loop;
    end loop;
  end
  $f$;

  -- ── Privileges of what the erasure and the bound run (before their fingerprints are taken) ───
  -- A trigger function needs no grant to fire (review B-7). The erasure's rewrites run as
  -- app_tenant (the soft delete, the purge) and as the owner (the cross-tenant pass). Nothing for
  -- anon, authenticated or service_role (Supabase grants new functions to them by default;
  -- to_regrole: a database without them, as an adopter's, is fine — review N-1).
  revoke all on function public.json_bound_refuse(), public.json_bound_depth_path(), public.json_bound_number_path(),
    public.json_bound_limit(regclass, name), public.json_bound_term(text, bigint), public.json_bound_reason(jsonb, bigint),
    public.json_bound_ddl(regclass), public.json_bound_tables(), public.json_bound_mark(regclass),
    public.json_bound_install(regclass[]), public.json_bound_check(regclass), public.json_bound_lock(regclass[], text),
    public.json_bound_off(regclass[]), public.json_bound_selftest(), public.json_bound_convert(regclass),
    public.jsonb_erase_id_text(jsonb, text), public.jsonb_erase_address_text(jsonb, text, text) from public;
  for r in select x.role from (values ('anon'), ('authenticated'), ('service_role')) x(role)
            where pg_catalog.to_regrole(x.role) is not null loop
    execute format('revoke all on function public.json_bound_refuse(), public.json_bound_depth_path(), public.json_bound_number_path(), public.json_bound_limit(regclass, name), public.json_bound_term(text, bigint), public.json_bound_reason(jsonb, bigint), public.json_bound_ddl(regclass), public.json_bound_tables(), public.json_bound_mark(regclass), public.json_bound_install(regclass[]), public.json_bound_check(regclass), public.json_bound_lock(regclass[], text), public.json_bound_off(regclass[]), public.json_bound_selftest(), public.json_bound_convert(regclass), public.jsonb_erase_id_text(jsonb, text), public.jsonb_erase_address_text(jsonb, text, text) from %I', r.role);
  end loop;
  if pg_catalog.to_regrole('app_tenant') is not null then
    grant execute on function public.jsonb_erase_id_text(jsonb, text), public.jsonb_erase_address_text(jsonb, text, text) to app_tenant;
  end if;

  -- ── Readiness ────────────────────────────────────────────────────────────────────────────────
  -- A function's fingerprint: its whole definition as Postgres prints it (body, arguments,
  -- SECURITY DEFINER, volatility, parallel safety, settings), its owner and its grants (review
  -- TA-a-6) — taken here, after the grants above, and written into the readiness functions below.
  --
  -- What the erasure calls, as this migration makes it: the gate the soft delete, the purge and the
  -- cross-tenant pass ask before they write (empty: go on). Missing (074 not applied) or another
  -- definition, owner or grant is named, so the erasure refuses rather than run a rewrite this
  -- design did not check.
  select string_agg(format('(%L, %L)', p.oid::pg_catalog.regprocedure::text,
                           md5(pg_catalog.pg_get_functiondef(p.oid) || '|' || p.proowner::pg_catalog.regrole::text || '|' || coalesce(p.proacl::text, ''))),
                    ', ' order by p.proname)
    into refuse_md5
    from pg_catalog.pg_proc p
   where p.oid in ('public.jsonb_erase_id_text(jsonb,text)'::pg_catalog.regprocedure,
                   'public.jsonb_erase_address_text(jsonb,text,text)'::pg_catalog.regprocedure);
  execute format($ddl$
  create or replace function public.erasure_functions_missing()
  returns setof text
  language sql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $g$
    select w.f || ': ' || case when p.oid is null then 'missing' else 'not as migration 074 makes it (definition, owner or grants)' end
      from (values %s) w(f, h)
      left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(w.f)
     where p.oid is null
        or md5(pg_catalog.pg_get_functiondef(p.oid) || '|' || p.proowner::pg_catalog.regrole::text || '|' || coalesce(p.proacl::text, '')) <> w.h
  $g$
  $ddl$, refuse_md5);

  -- Every way the bound is not in force, one line each, by name (never content); empty: in force.
  -- Read by readiness (probe json-bound: /api/health, the deploy smoke). A definer (it reads
  -- applied_migrations, which app_tenant does not), on fixed catalogue names under search_path
  -- pg_catalog, pg_temp (review RA2-4).
  refuse_md5 := (select string_agg(format('(%L, %L)', p.oid::pg_catalog.regprocedure::text,
                           md5(pg_catalog.pg_get_functiondef(p.oid) || '|' || p.proowner::pg_catalog.regrole::text || '|' || coalesce(p.proacl::text, ''))),
                    ', ' order by p.proname)
                   from pg_catalog.pg_proc p
                  where p.oid in ('public.json_bound_refuse()'::pg_catalog.regprocedure,
                                  'public.json_bound_reason(jsonb,bigint)'::pg_catalog.regprocedure,
                                  'public.json_bound_depth_path()'::pg_catalog.regprocedure,
                                  'public.json_bound_number_path()'::pg_catalog.regprocedure,
                                  -- and the ones that decide what is installed and where (code review
                                  -- A-6: a json_bound_limit answering 0 switched the size and number
                                  -- tests off at the next install, and readiness said nothing)
                                  'public.json_bound_limit(regclass,name)'::pg_catalog.regprocedure,
                                  'public.json_bound_term(text,bigint)'::pg_catalog.regprocedure,
                                  'public.json_bound_ddl(regclass)'::pg_catalog.regprocedure,
                                  'public.json_bound_tables()'::pg_catalog.regprocedure,
                                  'public.json_bound_mark(regclass)'::pg_catalog.regprocedure));
  execute format($ddl$
  create or replace function public.json_bound_missing()
  returns setof text
  language sql
  stable
  security definer
  set search_path = pg_catalog, pg_temp
  as $g$
    with covered as (
      -- A partition is named with its root: the root is what json_bound_install repairs (code
      -- review A-5: the line named the partition, which json_bound_install refuses).
      select c.oid as rel,
             case when c.relispartition
                  then pg_catalog.pg_partition_root(c.oid)::text || ' (its partition ' || c.oid::pg_catalog.regclass::text || ')'
                  else c.oid::pg_catalog.regclass::text end as name
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace s on s.oid = c.relnamespace
       where s.nspname = 'public' and c.relkind in ('r', 'p')
         and exists (select 1 from pg_catalog.pg_attribute a
                      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                        and a.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype)
    ), want as (
      select v.rel, v.name, public.json_bound_ddl(v.rel::pg_catalog.regclass) as ddl from covered v
    )
    -- 1. Each table's two triggers: present, enabled ALWAYS, exactly as json_bound_ddl writes them.
    select w.name || ': trigger ' || x.tg || ' ' ||
           case when g.oid is null then 'missing'
                when pg_catalog.pg_get_triggerdef(g.oid) is distinct from w.ddl[x.i]
                  then 'not as migration 074 makes it' || case when g.tgenabled <> 'A' then ', and not enabled ALWAYS (the bound is off)' else '' end
                else 'not enabled ALWAYS (the bound is off)' end
      from want w
      cross join lateral (values ('zz_json_bound_ins', 1), ('zz_json_bound_upd', 2)) x(tg, i)
      left join pg_catalog.pg_trigger g on g.tgrelid = w.rel and g.tgname = x.tg
     where g.oid is null or g.tgenabled <> 'A' or pg_catalog.pg_get_triggerdef(g.oid) <> w.ddl[x.i]
    union all
    -- 2. Rows of a table whose triggers were (re)made, or disabled and enabled again, or that gained
    --    a partition, since its rows were last read (json_bound_check() writes json_bound_mark: the
    --    versions of its triggers and of its partitions' clones).
    select t::text || ': existing rows not checked against the bound (run select public.json_bound_check(''' || t::text || '''))'
      from public.json_bound_tables() t
      join pg_catalog.pg_trigger g on g.tgrelid = t and g.tgname = 'zz_json_bound_ins'
     where coalesce(pg_catalog.obj_description(g.oid, 'pg_trigger'), '') is distinct from public.json_bound_mark(t)
    union all
    -- 3. A BEFORE row trigger that fires after the bound (named after it) could change a value
    --    after it was tested (review DA-18).
    select w.name || ': trigger ' || g.tgname || ' fires after the bound'
      from want w
      join pg_catalog.pg_trigger g on g.tgrelid = w.rel
     where not g.tgisinternal and (g.tgtype & 1) <> 0 and (g.tgtype & 2) <> 0
       and (((g.tgtype & 4) <> 0 and g.tgname::text collate "C" > 'zz_json_bound_ins')
            or ((g.tgtype & 16) <> 0 and g.tgname::text collate "C" > 'zz_json_bound_upd'))
    union all
    -- 4. A rule that rewrites writes to a public table (its writes would bypass the triggers).
    select r.ev_class::pg_catalog.regclass::text || ': rewrite rule ' || r.rulename
      from pg_catalog.pg_rewrite r
      join pg_catalog.pg_class c on c.oid = r.ev_class
      join pg_catalog.pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and r.ev_type <> '1'
    union all
    -- 5. Columns the bound cannot hold: json or jsonb inside another type (json, an array, a
    --    domain, a composite, a range), a generated jsonb column, a jsonb column of a view that
    --    stores rows or of a foreign table.
    select c.oid::pg_catalog.regclass::text || '.' || a.attname || ': ' ||
           case when a.attgenerated <> '' then 'a generated jsonb column is not checked by the bound'
                when c.relkind in ('m', 'f') then 'a jsonb column of a materialized view or foreign table is not checked by the bound'
                else 'type ' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ' holds JSON the bound cannot check' end
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace s on s.oid = c.relnamespace
     where s.nspname = 'public' and c.relkind in ('r', 'p', 'm', 'f') and a.attnum > 0 and not a.attisdropped
       and (
         (a.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype and (a.attgenerated <> '' or c.relkind in ('m', 'f')))
         or (a.atttypid <> 'pg_catalog.jsonb'::pg_catalog.regtype and exists (
           with recursive inner_types(t) as (
             select a.atttypid
             union
             select x.u from inner_types i
               join pg_catalog.pg_type ty on ty.oid = i.t
               cross join lateral (
                 select ty.typbasetype where ty.typbasetype <> 0
                 union all select ty.typelem where ty.typelem <> 0
                 union all select ca.atttypid from pg_catalog.pg_attribute ca
                            where ty.typrelid <> 0 and ca.attrelid = ty.typrelid and ca.attnum > 0 and not ca.attisdropped
                 union all select rg.rngsubtype from pg_catalog.pg_range rg where rg.rngtypid = ty.oid
                 union all select rg.rngsubtype from pg_catalog.pg_range rg where rg.rngmultitypid = ty.oid
               ) x(u)
           )
           select 1 from inner_types i where i.t in ('pg_catalog.json'::pg_catalog.regtype, 'pg_catalog.jsonb'::pg_catalog.regtype))))
    union all
    -- 6. The functions that decide a refusal, and what is installed on which table, as migration
    --    074 made them (definition, owner, grants): nine.
    select w.f || ': not as migration 074 makes it'
      from (values %s) w(f, h)
      left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(w.f)
     where p.oid is null
        or md5(pg_catalog.pg_get_functiondef(p.oid) || '|' || p.proowner::pg_catalog.regrole::text || '|' || coalesce(p.proacl::text, '')) <> w.h
    union all
    -- 7. Migrations 074 and 075 recorded.
    select f || ': not recorded'
      from (values ('074_json_bound.sql'), ('075_json_bound_existing_rows.sql')) m(f)
     where not exists (select 1 from public.applied_migrations a where a.filename = m.f)
    union all
    -- 8. What the erasure calls (the erasure's own gate, above).
    select m from public.erasure_functions_missing() m
    union all
    -- 9. What anon and authenticated may run (Supabase's default privileges grant new functions to
    --    them): none of the bound's or the erasure's functions.
    select p.oid::pg_catalog.regprocedure::text || ': executable by ' || g.r
      from pg_catalog.pg_proc p
      cross join (values ('anon'), ('authenticated')) g(r)
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.proname in ('json_bound_refuse', 'json_bound_depth_path', 'json_bound_number_path', 'json_bound_limit',
                         'json_bound_term', 'json_bound_reason', 'json_bound_ddl', 'json_bound_tables', 'json_bound_mark',
                         'json_bound_install', 'json_bound_lock', 'json_bound_off', 'json_bound_check', 'json_bound_selftest',
                         'json_bound_convert', 'json_bound_missing', 'erasure_functions_missing', 'jsonb_erase_id_text', 'jsonb_erase_address_text')
       and pg_catalog.to_regrole(g.r) is not null
       and pg_catalog.has_function_privilege(g.r, p.oid, 'EXECUTE')
    union all
    -- 10. TRIGGER on a covered table held by a role of the API: it could put its own trigger in
    --     place of the bound's (code review A-7). json_bound_install takes it away.
    select t::text || ': ' || g.r || ' holds TRIGGER on it and could replace the bound''s triggers (run select public.json_bound_install(array[''' || t::text || '''::regclass]))'
      from public.json_bound_tables() t
      cross join (values ('anon'), ('authenticated'), ('service_role')) g(r)
     where pg_catalog.to_regrole(g.r) is not null
       and pg_catalog.has_table_privilege(g.r, t, 'TRIGGER')
  $g$
  $ddl$, refuse_md5);

  revoke all on function public.json_bound_missing(), public.erasure_functions_missing() from public;
  for r in select x.role from (values ('anon'), ('authenticated'), ('service_role')) x(role)
            where pg_catalog.to_regrole(x.role) is not null loop
    execute format('revoke all on function public.json_bound_missing(), public.erasure_functions_missing() from %I', r.role);
  end loop;
  if pg_catalog.to_regrole('app_tenant') is not null then
    grant execute on function public.json_bound_missing(), public.erasure_functions_missing() to app_tenant;
  end if;

  -- ── Install, then record (last: a failure above leaves nothing, this record included) ────────
  perform public.json_bound_install();

  insert into public.applied_migrations (filename, confidence, note, checksum)
  values (
    '074_json_bound.sql',
    'verified',
    'TASK-229 (design 56e-3a): every jsonb column bounded — 128 levels, numbers 0 or 1e-18..1e21, 8 MiB of text as printed — by two BEFORE triggers (agent_trajectories.steps: depth only until 076); json_bound_install / json_bound_off / json_bound_check / json_bound_convert / json_bound_missing / json_bound_selftest; the soft delete''s and the purge''s rewrites lose no value and match no id across an escape (reviews A-1, A-2, TA-a-1).',
    'sha256:b44bc9ced0b979960fdc9376b13a69333939cf1059e29cd7c04fb83d4e2bbc3c'
  )
  on conflict (filename) do update set checksum = excluded.checksum;
end
$m074$;
