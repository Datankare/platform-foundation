/**
 * __tests__/migration-tracking.test.ts
 *
 * Every migration must record itself in public.applied_migrations (migration 025).
 *
 * Without this the convention decays the moment attention moves on — which is how three
 * migrations came to be applied by hand in Sprint 2 with no record of any of them.
 *
 * This is a source check, not a database check: it asserts the file contains its own
 * self-record insert. Whether it was actually applied is answered by querying the table.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

// 025 creates the table, so it is the first file able to record itself. Anything before it
// is covered by 025's backfill instead.
const TRACKING_MIGRATION = 25;

function migrationNumber(name: string): number | null {
  const m = /^(\d+)/.exec(name);
  return m ? Number(m[1]) : null;
}

describe("migration tracking (TASK-065)", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("finds migration files at all (self-test before any absence counts)", () => {
    // Gotcha 64: a check that passes by finding nothing is indistinguishable from a clean
    // result. Assert the directory is populated before trusting the loop below.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.startsWith("025"))).toBe(true);
  });

  const trackable = files.filter((f) => {
    const n = migrationNumber(f);
    return n !== null && n >= TRACKING_MIGRATION;
  });

  it.each(trackable)("%s records itself in applied_migrations", (file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    expect(sql).toMatch(/insert\s+into\s+applied_migrations/i);
    // The filename must appear, so a copy-pasted insert naming another migration fails.
    expect(sql).toContain(file);
  });
});
