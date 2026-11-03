/**
 * __tests__/migration-tracking.test.ts
 *
 * @guard a migration that does not record itself, or its checksum, in applied_migrations
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

/** Why a migration does not record itself in applied_migrations, or null when it does. */
function trackingProblem(file: string, sql: string): string | null {
  if (!/insert\s+into\s+(?:public\.)?applied_migrations/i.test(sql))
    return `${file}: no insert into applied_migrations`;
  // The filename must appear, so a copy-pasted insert naming another migration fails.
  if (!sql.includes(file)) return `${file}: its insert does not name the file`;
  return null;
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
    expect(
      trackingProblem(file, readFileSync(join(MIGRATIONS_DIR, file), "utf-8"))
    ).toBeNull();
  });

  it("[self-test] reports a planted migration that records nothing, or records another file", () => {
    expect(trackingProblem("099_planted.sql", "create table t (a int);")).toBe(
      "099_planted.sql: no insert into applied_migrations"
    );
    const copied =
      "insert into public.applied_migrations (filename) values ('098_other.sql');";
    expect(trackingProblem("099_planted.sql", copied)).toBe(
      "099_planted.sql: its insert does not name the file"
    );
    expect(
      trackingProblem(
        "099_planted.sql",
        "insert into applied_migrations (filename) values ('099_planted.sql');"
      )
    ).toBeNull();
  });
});

/**
 * TASK-197 (audit D-11): from 063, each migration records the checksum of its own file, so
 * parity (scripts/migration-parity.mjs) can tell a migration edited after it was applied. A
 * migration whose text changed without its stamp being renewed fails here — run
 * `node scripts/migration-checksum.mjs --write supabase/migrations/<file>`.
 */
describe("migration checksums (TASK-197)", () => {
  const CHECKSUM_FROM = 63;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => (migrationNumber(f) ?? 0) >= CHECKSUM_FROM)
    .sort();

  /** The script's own computation (an ES module), run by node. */
  function checksums(): Record<string, { stamp: string | null; checksum: string }> {
    const { execFileSync } =
      jest.requireActual<typeof import("child_process")>("child_process");
    const out = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { stampedMigrations } from ${JSON.stringify(join(process.cwd(), "scripts/migration-checksum.mjs"))};
         console.log(JSON.stringify(Object.fromEntries(stampedMigrations().map((m) => [m.file, m]))));`,
      ],
      { encoding: "utf8" }
    );
    return JSON.parse(out);
  }

  it("finds the migrations that must record a checksum", () => {
    expect(files).toContain("063_applied_migrations_checksum.sql");
  });

  it.each(files)(
    "%s records its own, current checksum in its applied_migrations insert",
    (file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      const insert = sql.slice(
        sql.search(/insert\s+into\s+(?:public\.)?applied_migrations/i)
      );
      expect(insert).toMatch(/\bchecksum\b/);
      expect(insert).toMatch(/'sha256:[0-9a-f]{64}'/);
      // A re-run records the file applied last (L5): the record is upserted, not left as it was.
      expect(insert).toMatch(
        /on\s+conflict\s*\(\s*filename\s*\)\s+do\s+update\s+set\s+checksum\s*=\s*excluded\.checksum/i
      );
      const m = checksums()[file];
      expect(m.stamp).toBe(m.checksum);
    }
  );

  it("the checksum changes with any edit, and ignores line endings and its own stamp", () => {
    const { execFileSync } =
      jest.requireActual<typeof import("child_process")>("child_process");
    const sum = (text: string) =>
      execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { migrationChecksum } from ${JSON.stringify(join(process.cwd(), "scripts/migration-checksum.mjs"))};
           console.log(migrationChecksum(process.argv[1]));`,
          text,
        ],
        { encoding: "utf8" }
      ).trim();
    const rec = (h: string, eol = "\n") =>
      `insert into public.applied_migrations (filename, checksum)${eol}values ('x.sql', 'sha256:${h.repeat(64)}');${eol}`;
    const a = sum("select 1;\n" + rec("a"));
    expect(sum("select 1;\r\n" + rec("b", "\r\n"))).toBe(a);
    expect(sum("select 2;\n" + rec("a"))).not.toBe(a);
    // Only the record's own stamp is ignored (L5): any other sha256: text is part of the file.
    const other = (h: string) =>
      `select 0;\n-- see sha256:${h.repeat(64)}\nselect 1;\n` + rec("a");
    expect(sum(other("c"))).not.toBe(sum(other("d")));
  });
});
