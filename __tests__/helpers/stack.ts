/**
 * __tests__/helpers/stack.ts — JSON operations at the smallest stack Postgres allows, on documents
 * at the bound's depth (platform TASK-229, ADR-058; design 56e-3a §2.4, T5)
 *
 * Whether Postgres can read, walk or build a deep JSON document depends on max_stack_depth and on
 * the build's stack frames (arm64 takes ~17 % more per level than x86-64). A test that picks a
 * depth "just under the limit" proves something about one machine only: the Mac gate (arm64,
 * PostgreSQL 17) failed r10's "depth 16 340 at the default stack". So the stack test drives every
 * operation the erasure uses on documents 128 deep — the bound, the deepest any stored value may be
 * — at max_stack_depth = 100kB, the least any Postgres allows: what passes there passes at every
 * stack on every architecture. Forcing the stack needs a superuser test owner; without one the
 * test FAILS (a test that cannot force the stack proves nothing about it).
 */

import type { Client } from "pg";

/** The stack every operation is driven at: max_stack_depth's minimum. */
export const SMALLEST_STACK = "100kB";

/** The document shapes: nested arrays, nested objects keyed by an address, and the two alternating. */
export const SHAPES = ["arr", "obj", "alt"] as const;

/** The operations of today's soft delete, purge, cross-tenant pass and export, and the bound's own walks. */
export const OPERATIONS = [
  "parse",
  "print",
  "path-exists-lax",
  "path-exists-strict-bound",
  "number-path",
  "concat-empty-array",
  "contains",
  "erase-address-text",
  "erase-id-text",
  "may-mention",
  "equal",
  "to_jsonb-row",
  "jsonb_set",
  "agg",
  "array-elements",
  "minus-keys",
  "typeof",
  "hash",
] as const;

/** Throw unless the session can force max_stack_depth (a superuser). */
export async function requireSuperuser(c: Client): Promise<void> {
  const { rows } = await c.query<{ su: string }>(
    "select current_setting('is_superuser') as su"
  );
  if (rows[0]?.su !== "on")
    throw new Error(
      "forcing max_stack_depth needs a superuser test owner (TEST_DATABASE_OWNER_URL); without it the stack test proves nothing, so it fails"
    );
}

/**
 * Create pg_temp.stack_ok(op, depth, shape) on `c`: true when `op` completes on a document `depth`
 * deep of `shape` at SMALLEST_STACK (the document is built at the default stack first, as a writer
 * stored it), false when the server's stack limit stopped it.
 */
export async function defineStackProbe(c: Client): Promise<void> {
  await c.query(`
    create or replace function pg_temp.stack_doc(d int, shape text) returns text language sql immutable as $$
      select case shape
        when 'arr' then repeat('[', d) || '"ann@x.com"' || repeat(']', d)
        when 'obj' then repeat('{"ann@x.com":', d) || '"3f2b1c4d-0000-4000-8000-00000000abcd"' || repeat('}', d)
        else (select string_agg(case when g % 2 = 0 then '{"3f2b1c4d-0000-4000-8000-00000000abcd":' else '[' end, '' order by g)
                     || '"ann@x.com"' ||
                     string_agg(case when g % 2 = 0 then '}' else ']' end, '' order by g desc)
                from generate_series(1, d) g)
      end $$`);
  await c.query(`
    create or replace function pg_temp.stack_ok(op text, d int, shape text) returns boolean language plpgsql as $$
    declare j jsonb; t text := pg_temp.stack_doc(d, shape); r jsonb; b boolean;
            id text := '3f2b1c4d-0000-4000-8000-00000000abcd';
    begin
      set local max_stack_depth = '2MB';
      j := t::jsonb;
      set local max_stack_depth = '${SMALLEST_STACK}';
      case op
        when 'parse' then r := t::jsonb;
        when 'print' then perform j::text;
        when 'path-exists-lax' then b := jsonb_path_exists(j, '$.** ? (@ == $u)', jsonb_build_object('u', id));
        when 'path-exists-strict-bound' then b := jsonb_path_exists(j, public.json_bound_depth_path());
        when 'number-path' then b := jsonb_path_exists(j, public.json_bound_number_path());
        when 'concat-empty-array' then perform pg_column_size(j || '[]'::jsonb);
        when 'contains' then b := j @> j;
        when 'erase-address-text' then r := public.jsonb_erase_address_text(j, 'ann@x.com', id);
        when 'erase-id-text' then r := public.jsonb_erase_id_text(j, id);
        when 'may-mention' then b := public.jsonb_may_mention_text(j, 'ann@x.com');
        when 'equal' then b := j = (t::jsonb);
        when 'to_jsonb-row' then r := to_jsonb(row(j, 1));
        when 'jsonb_set' then r := jsonb_set(jsonb_build_object('input', j), '{input}', j);
        when 'agg' then r := (select jsonb_agg(x) from (values (j), (j)) v(x));
        when 'array-elements' then perform count(*) from jsonb_array_elements(jsonb_build_array(j, j));
        when 'minus-keys' then r := jsonb_build_object('a', j, 'reason', 'x') - array['reason'];
        when 'typeof' then perform jsonb_typeof(j);
        when 'hash' then perform jsonb_hash(j);
      end case;
      return true;
    exception when statement_too_complex or program_limit_exceeded then
      return false;
    end $$`);
}
