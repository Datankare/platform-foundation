/**
 * @jest-environment node
 */
/**
 * __tests__/db/whole-row-functions.db.test.ts — no function or view the database holds reads a
 * whole table row (TASK-215, audit S3)
 *
 * @guard a SQL function, trigger function or view in the replayed schema that reads every column of a table row
 *
 * The source guard (__tests__/whole-row-reads.test.ts) reads the migrations and decides which
 * definitions are still live; this one asks the database the migrations built: every function of
 * the public schema written in SQL or PL/pgSQL (its body, pg_proc.prosrc), and every view (its
 * definition), checked with the same rules (helpers/whole-row-scan.ts). The platform's migrations
 * and an app's own alike; there is no list of accepted functions.
 */

import { connectTestDatabase, dbDescribe, disconnectTestDatabase } from "../helpers/db";
import { withOwnerTx } from "@/platform/data";
import { wholeRowFindings } from "../helpers/whole-row-scan";

/** "<name>: <construct>" for each whole-row read in the given definitions. */
export function definitionFindings(
  defs: readonly { name: string; body: string }[]
): string[] {
  return defs
    .flatMap((d) => wholeRowFindings(d.body).map((f) => `${d.name}: ${f.what}`))
    .sort();
}

dbDescribe("no whole-row reads in the database's functions and views (TASK-215)", () => {
  let defs: { name: string; body: string }[];

  beforeAll(async () => {
    await connectTestDatabase();
    defs = (
      await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query<{ name: string; body: string }>(
          `select p.oid::regprocedure::text as name, p.prosrc as body
             from pg_proc p join pg_language l on l.oid = p.prolang
            where p.pronamespace = 'public'::regnamespace and l.lanname in ('sql', 'plpgsql')
           union all
           select 'view ' || v.viewname, v.definition
             from pg_views v where v.schemaname = 'public'
           order by 1`
        )
      )
    ).rows;
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it("reads a plausible number of definitions", () => {
    expect(defs.length).toBeGreaterThan(20);
    expect(defs.some((d) => d.name.includes("tenant_export_rows("))).toBe(true);
  });

  it("no function or view reads a whole row", () => {
    expect(definitionFindings(defs)).toEqual([]);
  });

  it("[self-test] a whole-row body is reported, by its function", () => {
    expect(
      definitionFindings([
        {
          name: "tenant_export_rows(text,uuid)",
          body: "begin return query execute format('select to_jsonb(r) from public.%I r where r.tenant_id = $1', p_table) using p_tenant; end;",
        },
        {
          name: "audit_row()",
          body: "begin perform pg_notify('a', row_to_json(new)::text); return new; end;",
        },
        { name: "ok()", body: "select jsonb_build_object('id', u.id) from users u" },
      ])
    ).toEqual([
      "audit_row(): row_to_json(new)",
      "tenant_export_rows(text,uuid): to_jsonb(r)",
    ]);
  });
});
