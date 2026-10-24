/**
 * @jest-environment node
 */
/**
 * __tests__/db/sql-schema-parity.db.test.ts — every SQL statement the code sends is valid
 * against the migrated schema (TASK-067, ADR-053 D4)
 *
 * Replaces scripts/schema-parity.mjs, which read PostgREST calls out of the source and compared
 * column names with CREATE TABLE text. The stores now send SQL, so the check asks Postgres
 * itself: each statement found in the production sources is planned against the replayed
 * database with EXPLAIN (GENERIC_PLAN) (Postgres 16+), which parses, analyses and plans without
 * running — so it proves every table, column, function, cast, conflict target (an ON CONFLICT
 * arbiter is matched only when planning; PREPARE alone accepts a wrong one) and parameter type
 * exists and fits, exactly what fails on first call in production otherwise, and changes
 * nothing.
 *
 * The statements are found with the TypeScript parser: every string or template literal
 * (without substitutions — data-sql-hygiene refuses those in SQL) that reads as a statement.
 * The self-tests below fail if the finder starts finding nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import * as ts from "typescript";
import { dbDescribe } from "../helpers/db";
import { productionSources } from "../helpers/route-policy";

const ROOT = process.cwd();

/** A literal that begins a statement Postgres can plan (or LOCK, checked separately). */
const STATEMENT =
  /^\s*(?:select\s[\s\S]*?(?:\bfrom\b|\w\s*\(|\$\d)|insert\s+into\s|update\s+[\w.]+\s+(?:as\s+\w+\s+)?set\s|delete\s+from\s|with\s+\w+\s+as\s*\(|lock\s+table\s)/i;

interface Found {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function statementsIn(file: string): Found[] {
  const src = readFileSync(join(ROOT, file), "utf-8");
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: Found[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // An import path or a JSX attribute is never SQL; a literal that is only part of a
      // statement (concatenation) is refused by data-sql-hygiene when it reaches a query.
      if (STATEMENT.test(node.text) && !ts.isImportDeclaration(node.parent)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ file, line: line + 1, text: node.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const FOUND: Found[] = productionSources()
  .filter((f) => /\.tsx?$/.test(f))
  .flatMap(statementsIn);

dbDescribe("SQL schema parity — every statement plans against the migrations", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("finds the statements (self-test before any absence counts)", () => {
    expect(FOUND.length).toBeGreaterThan(150);
    const files = new Set(FOUND.map((f) => f.file));
    for (const f of [
      "platform/agents/postgres-budget-store.ts",
      "platform/tenancy/postgres-directory.ts",
      "platform/auth/platform-config.ts",
      "platform/moderation/review-store.ts",
    ]) {
      expect(files).toContain(f);
    }
  });

  it("recognises statements and nothing else (self-test)", () => {
    for (const s of [
      "select a from b where c = $1",
      "select app_current_tenant()",
      "select $1::int",
      "insert into t (a) values ($1)",
      "update t set a = $1",
      "update t as x set a = $1",
      "delete from t where a = $1",
      "with x as (select 1) select * from x",
      "lock table t in exclusive mode",
      "\n      select id\n        from tenants",
    ]) {
      expect(STATEMENT.test(s)).toBe(true);
    }
    for (const s of [
      "Select a tenant",
      "select",
      "Update the settings",
      "delete",
      "insert a coin",
      "selected",
    ]) {
      expect(STATEMENT.test(s)).toBe(false);
    }
  });

  it("refuses what production would refuse (self-test)", async () => {
    for (const bad of [
      "select no_such_column from tenants",
      "insert into tenant_config_overrides (key, no_such_column) values ($1, $2)",
      "select * from no_such_table",
      "insert into tenants (id, slug, name) values ($1, $2, $3) on conflict (name) do nothing",
    ]) {
      await expect(client.query(`explain (generic_plan) ${bad}`)).rejects.toThrow();
    }
  });

  it("every statement is valid against the schema", async () => {
    const failures: string[] = [];
    await client.query("begin");
    try {
      for (const [i, f] of FOUND.entries()) {
        await client.query(`savepoint s${i}`);
        try {
          if (/^\s*lock\s/i.test(f.text)) {
            // LOCK cannot be planned; run it in this transaction, which is rolled back.
            await client.query(f.text);
          } else {
            await client.query(`explain (generic_plan) ${f.text}`);
          }
          await client.query(`release savepoint s${i}`);
        } catch (e) {
          await client.query(`rollback to savepoint s${i}`);
          failures.push(
            `${f.file}:${f.line}: ${(e as Error).message}\n    ${f.text.trim().replace(/\s+/g, " ").slice(0, 160)}`
          );
        }
      }
    } finally {
      await client.query("rollback");
    }
    expect(failures).toEqual([]);
  });
});
