/**
 * __tests__/migration-guide-counts.test.ts — the promotion guides' counts and lists come from the
 * migrations directory (TASK-212)
 *
 * @guard a promotion guide whose migration count or list no longer matches supabase/migrations
 *
 * Playform's guide said the record check shows "twenty-three rows" from 046 after 065–068 had made
 * it 27 (register NEW-2): written once in prose, never compared with the files again. Now each
 * number and list an operator checks a database against is derived here from the directory:
 *
 *   - MIGRATION_v5_to_v6 (every repository): every platform migration from 046 has its
 *     `pbcopy < supabase/migrations/<file>` line, once.
 *   - an app's own guide, docs/<APP>_MIGRATION_v…_to_v….md (Playform's PLAYFORM_MIGRATION_v0.8_to_v0.9;
 *     platform-foundation has none): §1's
 *     table and its pbcopy list name every file from 046 once each — the app's own too — and
 *     "applies `064` to `NNN`" names the newest platform migration; the record check's row count
 *     ("— N rows") is the number of files from 046 (the SQL's `filename >= '046'`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase/migrations");
const PLATFORM_GUIDE = join(ROOT, "docs/MIGRATION_v5_to_v6.md");

/** Files from 046, compared as the record check's SQL compares them (filename >= '046'). */
const fromThe046 = (files: readonly string[]) =>
  files.filter((f) => /\.sql$/.test(f) && f >= "046").sort();

const platformMigrations = (): string[] =>
  (
    JSON.parse(readFileSync(join(ROOT, "supabase/platform-migrations.json"), "utf8")) as {
      migrations: string[];
    }
  ).migrations;

/** How many times `pbcopy < supabase/migrations/<file>` appears, per file. */
function pbcopyCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/pbcopy < supabase\/migrations\/(\S+\.sql)/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

/** The record check's row count: "… none twice — N rows". */
function recordRowCount(text: string): number | undefined {
  const m = /none twice — (\d+) rows/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** The §1 table's files, in its order (`| n | \`file\` |`). */
function tableFiles(text: string): string[] {
  return [...text.matchAll(/^\| \d+\s+\| `(\d{3}[a-z]?_[^`]+\.sql)`/gm)].map((m) => m[1]);
}

describe("the promotion guides' migration counts (TASK-212)", () => {
  const files = readdirSync(MIGRATIONS);

  it("MIGRATION_v5_to_v6 copies every platform migration from 046 once", () => {
    const counts = pbcopyCounts(readFileSync(PLATFORM_GUIDE, "utf8"));
    const wanted = fromThe046(platformMigrations());
    expect(wanted).toContain("069_provider_usage.sql");
    expect(wanted.filter((f) => counts.get(f) !== 1)).toEqual([]);
  });

  // An app's own promotion guides (Playform's PLAYFORM_MIGRATION_v0.8_to_v0.9.md; none in
  // platform-foundation): each is held to the directory.
  const appGuides = readdirSync(join(ROOT, "docs"))
    .filter((f) => /^[A-Z]+_MIGRATION_v[\d.]+_to_v[\d.]+\.md$/.test(f))
    .map((f) => ({ name: f, text: readFileSync(join(ROOT, "docs", f), "utf8") }));
  const wanted = fromThe046(files);

  it("an app's guide: the record check's row count is the number of files from 046", () => {
    for (const g of appGuides)
      expect({ guide: g.name, rows: recordRowCount(g.text) }).toEqual({
        guide: g.name,
        rows: wanted.length,
      });
  });

  it("an app's guide: §1's table and its pbcopy list name every file from 046, once each", () => {
    for (const g of appGuides) {
      expect([...tableFiles(g.text)].sort()).toEqual(wanted);
      const counts = pbcopyCounts(g.text);
      expect(wanted.filter((f) => counts.get(f) !== 1)).toEqual([]);
      expect([...counts.keys()].filter((f) => !wanted.includes(f))).toEqual([]);
    }
  });

  it("an app's guide names the newest platform migration as the last a database applies", () => {
    const newest = fromThe046(platformMigrations())
      .filter((f) => /^\d{3}_/.test(f))
      .pop();
    for (const g of appGuides) {
      expect(g.text).toContain(`applies \`064\` to \`${newest!.slice(0, 3)}\``);
    }
  });

  it("[self-test] the readers find what the guides write", () => {
    expect(recordRowCount("each `verified`, none twice — 27 rows (as many")).toBe(27);
    expect(recordRowCount("none twice — twenty-three rows")).toBeUndefined();
    expect(
      tableFiles("| 7     | `052a_playform_x.sql`   | Playform\n| 8 | `053_y.sql` | z")
    ).toEqual(["052a_playform_x.sql", "053_y.sql"]);
    const c = pbcopyCounts(
      "pbcopy < supabase/migrations/a.sql\npbcopy < supabase/migrations/a.sql"
    );
    expect(c.get("a.sql")).toBe(2);
    expect(fromThe046(["045_x.sql", "046_y.sql", "064a_z.sql", "README.md"])).toEqual([
      "046_y.sql",
      "064a_z.sql",
    ]);
  });
});
