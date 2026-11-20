/**
 * @jest-environment node
 */
/**
 * __tests__/db/k-queries.db.test.ts — the owner's read-only questions about today's soft delete
 * (review A-2) return the documented shape (platform TASK-229; design 56e-3a §5.1 step 0, T13;
 * reviews RA2-5, RB2-11, DA-25, DB-16, S11)
 *
 * @not-guard: it reads the guide to run the owner's queries as pasted, and scans nothing.
 *
 * What it refuses: an owner query in the migration guide that the schema would refuse or that answers in
 * another shape than the guide says
 *
 * 052's soft-delete rewrite could drop a value or put a stand-in in place of a document (review
 * A-2). Whether a project holds such damage is asked by three read-only queries the owner pastes
 * at step 0 (docs/MIGRATION_v5_to_v6.md, "Step 0: the A-2 question"): K-1 was 052 applied, K-2
 * soft deletes since its code shipped, K-3 per rewritten column the documents of the at-risk shape.
 * The queries are read from the guide itself, so what is tested is what the owner pastes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { dbDescribe, DB_ENABLED } from "../helpers/db";

const GUIDE = readFileSync(
  join(__dirname, "..", "..", "docs", "MIGRATION_v5_to_v6.md"),
  "utf8"
);

/** The fenced SQL block of the guide whose first line starts with `-- K-n`. */
export function kQuery(guide: string, n: 1 | 2 | 3): string {
  const blocks = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  const found = blocks.filter((b) => b.startsWith(`-- K-${n} `));
  if (found.length !== 1) throw new Error(`the guide has ${found.length} K-${n} blocks`);
  return found[0];
}

let owner: Client;
if (DB_ENABLED) {
  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
  });
}

describe("the guide carries each K query once", () => {
  it.each([1, 2, 3] as const)("K-%i", (n) => {
    expect(kQuery(GUIDE, n)).toMatch(/^-- K-\d \(read-only\)/);
  });
});

dbDescribe(
  "T13: K-1..K-3 on the replayed schema, as the owner pastes them (one statement each)",
  () => {
    it("K-1: 052's record (the replay applies it): filename, recorded_at, checksum", async () => {
      const { rows, fields } = await owner.query(kQuery(GUIDE, 1));
      expect(fields.map((f) => f.name)).toEqual(["filename", "recorded_at", "checksum"]);
      expect(rows.map((r) => r.filename)).toEqual(["052_audit_wave2.sql"]);
    });

    it("K-2 (DA-25: soft_deleted_at): sees_every_row t, and the two counts", async () => {
      const { rows, fields } = await owner.query(kQuery(GUIDE, 2));
      expect(fields.map((f) => f.name)).toEqual([
        "sees_every_row",
        "soft_deletes_since_052_code",
        "of_which_purged",
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].sees_every_row).toBe(true);
    });

    it("K-3 (RA2-5): all seven rewritten columns listed even when empty, three counts each", async () => {
      const { rows, fields } = await owner.query(kQuery(GUIDE, 3));
      expect(fields.map((f) => f.name)).toEqual([
        "tbl",
        "stand_ins",
        "numbered_keys",
        "at_risk",
      ]);
      expect(rows.map((r) => r.tbl)).toEqual([
        "agent_trajectories.steps",
        "app_sessions.state",
        "audit_log.details",
        "proposals.effects",
        "proposals.payload",
        "review_queue.explanation_chain",
        "review_queue.moderation_result",
      ]);
    });

    it("K-3 finds a stand-in and a document of the at-risk shape (rolled back)", async () => {
      await owner.query("begin");
      try {
        await owner.query(
          `insert into public.audit_log (tenant_id, action, details)
         select id, 'account_deleted', '{"x": "erasure: key collision", "k": [": hi", {"3f2b1c4d-0000-4000-8000-00000000abcd": 1}]}'::jsonb
           from public.tenants limit 1`
        );
        const { rows } = await owner.query(kQuery(GUIDE, 3));
        const audit = rows.find((r) => r.tbl === "audit_log.details");
        expect(Number(audit.stand_ins)).toBeGreaterThanOrEqual(1);
        expect(Number(audit.at_risk)).toBeGreaterThanOrEqual(1);
      } finally {
        await owner.query("rollback");
      }
    });
  }
);

/** The fenced SQL block of the guide that counts the rows over the bound (code review A-2). */
export function overBoundQuery(guide: string): string {
  const blocks = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  const found = blocks.filter((b) => b.startsWith("-- Rows over the bound, counted "));
  if (found.length !== 1)
    throw new Error(`the guide has ${found.length} "Rows over the bound" blocks`);
  return found[0];
}

describe("the guide carries the count of rows over the bound once, and it needs nothing of 074", () => {
  it("one block; it calls no function of migration 074 (it is pasted before it)", () => {
    const sql = overBoundQuery(GUIDE);
    expect(sql).toMatch(/^-- Rows over the bound, counted \(read-only; paste BEFORE 074/);
    expect(sql).not.toMatch(/json_bound_|jsonb_erase_/);
    // Its three tests are the bound's: 128 levels, the number range, 8 MiB as text.
    expect(sql).toContain("$.**{128}");
    expect(sql).toContain("@.abs() >= 1e21 || @.abs() < 1e-18");
    expect(sql).toContain("> 8388608");
  });
});

dbDescribe(
  "T13 (code review A-2): the rows the bound would refuse are counted before 074, per column and reason",
  () => {
    it("the replayed schema: the TOTAL row alone, every count 0, every jsonb column read", async () => {
      const { rows, fields } = await owner.query(overBoundQuery(GUIDE));
      expect(fields.map((f) => f.name)).toEqual([
        "jsonb_column",
        "too_deep",
        "bad_number",
        "too_long",
        "sees_every_row",
      ]);
      expect(rows).toHaveLength(1);
      const { rows: n } = await owner.query<{ n: number }>(
        `select count(*)::int as n from pg_class c join pg_namespace s on s.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid
          where s.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
            and a.atttypid = 'jsonb'::regtype`
      );
      expect(rows[0]).toEqual({
        jsonb_column: `TOTAL (${n[0].n} jsonb columns read)`,
        too_deep: "0",
        bad_number: "0",
        too_long: "0",
        sees_every_row: true,
      });
    });

    it("planted rows (a table without the bound, rolled back): each counted once, under its first reason — a value 3 000 deep holding 1e30 is 'too deep', and stops nothing", async () => {
      await owner.query("begin");
      try {
        await owner.query("create table public.t13_old (id int, a jsonb, b jsonb)");
        await owner.query(
          `insert into public.t13_old values
             (1, '[1e30]', (repeat('[', 200) || repeat(']', 200))::jsonb),
             (2, '1', ('[' || repeat('0e-16383,', 599) || '0e-16383]')::jsonb),
             (3, '{"a": 1e-19}', '{"ok": [1e-18, 0, 999999999999999999999]}'),
             (4, (repeat('[', 3000) || '1e30' || repeat(']', 3000))::jsonb, null)`
        );
        const { rows } = await owner.query(overBoundQuery(GUIDE));
        const by = Object.fromEntries(
          rows.map((r) => [
            r.jsonb_column,
            [r.too_deep, r.bad_number, r.too_long].map(Number),
          ])
        );
        expect(by["t13_old.a"]).toEqual([1, 2, 0]);
        expect(by["t13_old.b"]).toEqual([1, 0, 1]);
        const total = rows.find((r) => String(r.jsonb_column).startsWith("TOTAL"));
        expect([total.too_deep, total.bad_number, total.too_long].map(Number)).toEqual([
          2, 2, 1,
        ]);
        // What it counts is what the bound refuses: the same rows, named by json_bound_check.
        await owner.query(
          "select public.json_bound_install(array['public.t13_old'::regclass])"
        );
        await owner.query("savepoint a");
        const err = await owner
          .query("select public.json_bound_check('public.t13_old')")
          .then(
            () => null,
            (e: { message: string }) => e
          );
        await owner.query("rollback to savepoint a");
        expect(err?.message).toMatch(/^json_bound_check: 4 row\(s\) over the bound/);
      } finally {
        await owner.query("rollback");
      }
    }, 60_000);
  }
);
