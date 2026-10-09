/**
 * __tests__/schema-baseline.test.ts — TASK-091
 *
 * Source checks on supabase/baseline/000_baseline.sql. The CI job "Migration replay" executes
 * it; these keep its contract honest without a database:
 *   - it refuses to run over an existing schema;
 *   - it records exactly the migrations it covers, and none it does not (a newer migration
 *     must be replayed, never assumed);
 *   - nothing consumer-owned or Supabase-generated has crept in;
 *   - every table a migration newer than the baseline creates also enables row-level
 *     security — production has no automatic-RLS trigger, dev does.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const BASELINE = readFileSync(join(ROOT, "supabase/baseline/000_baseline.sql"), "utf-8");
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

// The statements only — the header names what was excluded, on purpose.
const STATEMENTS = BASELINE.split("\n")
  .filter((line) => !line.startsWith("--"))
  .join("\n");

const coversThrough = Number(
  /^-- baseline-covers-through: (\d+)$/m.exec(BASELINE)?.[1] ?? Number.NaN
);
const num = (f: string) => Number(/^(\d+)/.exec(f)?.[1]);

describe("schema baseline (TASK-091)", () => {
  it("declares what it covers", () => {
    expect(Number.isInteger(coversThrough)).toBe(true);
    expect(coversThrough).toBeGreaterThan(0);
  });

  it("refuses to run over an existing schema, before any DDL", () => {
    const guard = BASELINE.indexOf("the baseline is for new databases only");
    const firstDdl = BASELINE.search(/^CREATE (TABLE|TYPE|FUNCTION|EXTENSION)/m);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstDdl);
  });

  it("records every covered migration and no newer one", () => {
    for (const f of migrations) {
      const recorded = BASELINE.includes(`('${f}', 'verified'`);
      expect({ f, recorded }).toEqual({ f, recorded: num(f) <= coversThrough });
    }
  });

  it("contains nothing consumer-owned or Supabase-generated", () => {
    for (const foreign of [
      "agent_delegation_grant",
      "agent_delegation_audit",
      "rls_auto_enable",
      "supabase_admin",
      "\\restrict",
    ]) {
      expect({ foreign, present: STATEMENTS.includes(foreign) }).toEqual({
        foreign,
        present: false,
      });
    }
  });

  it("creates the vector extension it needs", () => {
    expect(BASELINE).toMatch(
      /^CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;$/m
    );
  });

  it("every newer migration that creates a table enables row-level security on it", () => {
    for (const f of migrations.filter((m) => num(m) > coversThrough)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
      const tables = [
        ...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi),
      ].map((m) => m[1]);
      for (const t of tables) {
        const rls = new RegExp(
          `alter\\s+table\\s+(?:public\\.)?${t}\\s+enable\\s+row\\s+level\\s+security`,
          "i"
        );
        expect({ f, t, rls: rls.test(sql) }).toEqual({ f, t, rls: true });
      }
    }
  });
});
