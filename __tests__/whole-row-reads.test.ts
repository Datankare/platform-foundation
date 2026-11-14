/**
 * __tests__/whole-row-reads.test.ts — no statement reads a whole table row (TASK-215, audit S3)
 *
 * @guard SQL that reads every column of a table row — select *, returning *, x.*, to_jsonb(row) — in the code or a live migration
 *
 * A statement that names no columns reads every column the table has now and every one a later
 * migration adds, into memory, a response or an export, without anyone deciding it should (audit
 * S3: the operator's tenant export, A-7; the profile export, A-14; the audit-log read that carried
 * other people's addresses and browsers into the appeals route; the password-policy reads). So every
 * statement names its columns. The rules are helpers/whole-row-scan.ts's.
 *
 * Where: every SQL string and template literal of the code that runs against a deployment's data —
 * app, platform, lib, components, hooks, shared, prompts, modules, the entry files and the operator
 * scripts (scripts/*.mjs, *.cjs, *.js, *.ts) — and every migration, an app's own included. A
 * migration's function or view counts only while no later migration replaces or drops it: the
 * migrations are immutable once applied (063's checksums), so the fix for a whole-row function is a
 * new migration that redefines it. Test code, and scripts/migration-replay.sh — the CI harness that
 * fingerprints a scratch database's every row to prove a second application changes nothing — read
 * no deployment's data and are not scanned. There is no list of accepted sites: a finding fails.
 *
 * The functions and views a replayed database actually holds are checked by
 * __tests__/db/whole-row-functions.db.test.ts, with the same rules.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  migrationFindings,
  rowNames,
  sourceFindings,
  wholeRowFindings,
} from "./helpers/whole-row-scan";

const ROOT = join(__dirname, "..");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

/** The source files scanned: the code that runs against a deployment's data. */
function scannedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith("."))
        continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        /\.(?:ts|tsx|mjs|cjs|js)$/.test(name) &&
        !/\.(?:test|spec)\.[jt]sx?$/.test(name)
      )
        out.push(p);
    }
  };
  for (const d of [
    "app",
    "platform",
    "lib",
    "components",
    "hooks",
    "shared",
    "prompts",
    "modules",
    "scripts",
  ])
    walk(join(ROOT, d));
  for (const f of ["instrumentation.ts", "proxy.ts", "middleware.ts"]) {
    try {
      if (statSync(join(ROOT, f)).isFile()) out.push(join(ROOT, f));
    } catch {
      /* absent */
    }
  }
  return out.map(rel).sort();
}

function migrations(): { name: string; text: string }[] {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

describe("no whole-row reads (TASK-215, audit S3)", () => {
  it("finds a plausible number of sources and migrations to scan", () => {
    expect(scannedSources().length).toBeGreaterThan(300);
    expect(migrations().length).toBeGreaterThan(60);
  });

  it("no source statement reads a whole row", () => {
    const found = scannedSources().flatMap((f) =>
      sourceFindings(readFileSync(join(ROOT, f), "utf8"), f).map(
        (x) => `${f}:${x.line} ${x.what}`
      )
    );
    expect(found).toEqual([]);
  });

  it("no live migration statement reads a whole row", () => {
    expect(
      migrationFindings(migrations()).map((x) => `${x.file}:${x.line} ${x.what}`)
    ).toEqual([]);
  });

  it("[self-test] every whole-row form is found", () => {
    const planted = [
      "select * from users where id = $1",
      "select distinct * from audit_log",
      "select a.*, b.id from audit_log a join users b on b.id = a.actor_id",
      "insert into roles (name) values ($1) returning *",
      "select to_jsonb(u) as r from users u where u.id = $1",
      "select row_to_json(users) from users",
      "select json_agg(a) from audit_log a",
      "select to_jsonb(r) from public.%I r where r.tenant_id = $1",
      "update users u set name = 'x' returning to_jsonb(u)",
      "select row(c.*) from consent_records c",
      "perform pg_notify('x', to_jsonb(new)::text)",
    ];
    for (const sql of planted)
      expect([sql, wholeRowFindings(sql).length]).toEqual([sql, 1]);
  });

  it("[self-test] named columns, a column, a parameter, a derived table and literals are not rows", () => {
    const clean = [
      "select id, email from users where id = $1",
      "select count(*) from users",
      "select to_jsonb(decided_by) from proposals where id = $1",
      "select to_jsonb(t) - '_k' as r from (select id, ctid as _k from groups where owner_id = $1) t",
      "select * from (values ('a', 'b')) as v (x, y)",
      "select jsonb_build_object('id', u.id) from users u",
      "select to_jsonb($1::text)",
    ];
    for (const sql of clean) expect([sql, wholeRowFindings(sql)]).toEqual([sql, []]);
  });

  it("[self-test] a whole-row read in a TypeScript literal is found on its line", () => {
    const src = [
      "const a = 1;",
      "await tx.query(`select * from password_policy",
      "  where role_id is null`);",
      'await tx.query("select id from users");',
    ].join("\n");
    expect(sourceFindings(src)).toEqual([{ line: 2, what: "select *" }]);
  });

  it("[self-test] a migration's whole-row function counts until a later migration replaces or drops it", () => {
    const old = {
      name: "049_x.sql",
      text: [
        "create or replace function public.export_rows(p_table text, p_tenant uuid)",
        "returns setof jsonb language plpgsql as $$",
        "begin",
        "  return query execute format('select to_jsonb(r) from public.%I r where r.tenant_id = $1', p_table) using p_tenant;",
        "end;",
        "$$;",
      ].join("\n"),
    };
    expect(migrationFindings([old])).toEqual([
      { file: "049_x.sql", line: 4, what: "to_jsonb(r)" },
    ]);
    const replaced = {
      name: "071_y.sql",
      text: "create or replace function public.export_rows(t text, p uuid) returns setof jsonb language sql as $$ select jsonb_build_object('id', 1) $$;",
    };
    expect(migrationFindings([old, replaced])).toEqual([]);
    const dropped = {
      name: "071_z.sql",
      text: "drop function if exists public.export_rows(text, uuid);",
    };
    expect(migrationFindings([old, dropped])).toEqual([]);
    // A replacement with other argument types is another function: the old one stays live.
    const other = {
      name: "071_w.sql",
      text: "create or replace function public.export_rows(t text) returns setof jsonb language sql as $$ select '{}'::jsonb $$;",
    };
    expect(migrationFindings([old, other])).toHaveLength(1);
    // A one-time statement counts where it is.
    expect(
      migrationFindings([{ name: "070_v.sql", text: "insert into a select * from b;" }])
    ).toEqual([{ file: "070_v.sql", line: 1, what: "select *" }]);
  });

  it("[self-test] a statement's row names are its tables and their aliases, never a derived table", () => {
    const names = rowNames(
      "select x from public.users u join roles r on r.id = u.role_id, groups g where (select 1 from (select id from t) d)"
    );
    expect([...names].filter((n) => !["new", "old"].includes(n)).sort()).toEqual(
      ["g", "groups", "r", "roles", "t", "u", "users"].sort()
    );
  });
});
