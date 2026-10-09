/**
 * __tests__/schema-baseline.test.ts — TASK-091
 *
 * Source checks on supabase/baseline/000_baseline.sql. The CI job "Migration replay" executes
 * it; these keep its contract honest without a database:
 *   - it refuses to run over an existing schema;
 *   - it records only migration files that exist, none numbered past what it covers (a newer
 *     migration must be replayed, never assumed), and — in platform-foundation — every one it
 *     covers. In a consuming app, a migration it does not record is the app's own (TASK-119):
 *     it is replayed after the baseline, whatever its number;
 *   - nothing consumer-owned or Supabase-generated has crept in;
 *   - every table a migration the baseline does not record creates also enables row-level
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
/** The migration files the baseline records as applied (it also records itself: 000_baseline). */
const RECORDED = [...BASELINE.matchAll(/\('(\d+_[^']+\.sql)', 'verified'/g)]
  .map((m) => m[1])
  .filter((f) => f !== "000_baseline.sql");
const isRecorded = (f: string) => RECORDED.includes(f);
/** platform-foundation itself — where every migration up to the baseline's number is its own. */
const IS_PLATFORM =
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).name ===
  "platform-foundation";

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

  it("records only migrations that exist, and none past what it covers", () => {
    expect(RECORDED.length).toBeGreaterThan(0);
    for (const f of RECORDED) {
      expect({
        f,
        exists: migrations.includes(f),
        covered: num(f) <= coversThrough,
      }).toEqual({ f, exists: true, covered: true });
    }
    for (const f of migrations.filter((m) => num(m) > coversThrough)) {
      expect({ f, recorded: isRecorded(f) }).toEqual({ f, recorded: false });
    }
  });

  it("in platform-foundation, records every migration it covers (no gap in the chain)", () => {
    const unrecorded = migrations.filter(
      (f) => num(f) <= coversThrough && !isRecorded(f)
    );
    // In a consuming app these are its own migrations, replayed after the baseline (TASK-119).
    expect(IS_PLATFORM ? unrecorded : []).toEqual([]);
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

  it("every migration the baseline does not record enables row-level security on its tables", () => {
    for (const f of migrations.filter((m) => !isRecorded(m))) {
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
