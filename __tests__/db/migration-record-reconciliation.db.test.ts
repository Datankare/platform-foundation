/**
 * @jest-environment node
 */
/**
 * __tests__/db/migration-record-reconciliation.db.test.ts — the documented reconciliation of the
 * migration record runs as written, against the real schema, and refuses what it says it refuses
 * (N-87, TASK-203)
 * @not-guard: runs the documented owner SQL against a database; reads the document to execute it
 *
 * The block is read from docs/TENANCY_OPERATIONS.md ("Reconciling the migration record") with its
 * check, and run in a transaction that is always rolled back: a retire of a record with no checksum,
 * a record of a file not recorded, and each refusal — the placeholders left, another action, a name
 * that is no migration's, the baseline's record, a record with its checksum, a record twice, a
 * reason that is not a sentence. Each run writes its audit record in the same transaction.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectTestDatabase, dbDescribe, disconnectTestDatabase } from "../helpers/db";
import { withOwnerTx, type Tx } from "@/platform/data";

const DOC = readFileSync(join(__dirname, "../../docs/TENANCY_OPERATIONS.md"), "utf8");
const SECTION = DOC.slice(DOC.indexOf("### Reconciling the migration record"));
const [PROCEDURE, CHECK] = [...SECTION.matchAll(/```sql\n([\s\S]*?)```/g)].map(
  (m) => m[1]
);

class Rollback extends Error {}

async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T | Error> {
  let out: T | Error = new Error("not run");
  try {
    await withOwnerTx("tenant-lifecycle", async (tx) => {
      try {
        out = await fn(tx);
      } catch (err) {
        out = err as Error;
      }
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

/** The block with its three values replaced (null: left as written), without its begin/commit. */
function procedure(
  action: string | null,
  file: string | null,
  reason: string | null
): string {
  let body = PROCEDURE.replace(/^begin;\n/m, "").replace(/^commit;\n?/m, "");
  if (action !== null)
    body = body.replace("'REPLACE-WITH-retire-OR-record'", `'${action}'`);
  if (file !== null) body = body.replace("'REPLACE-WITH-THE-FILE-NAME.sql'", `'${file}'`);
  if (reason !== null)
    body = body.replace(
      "'REPLACE-WITH-WHY: the parity run, and what you checked'",
      `'${reason}'`
    );
  return body;
}

const REASON = "parity run of 2026-11-02 named it; no branch has the file";

dbDescribe(
  "reconciling the migration record, as TENANCY_OPERATIONS documents it (N-87)",
  () => {
    beforeAll(connectTestDatabase);
    afterAll(disconnectTestDatabase);

    const run = (setup: (tx: Tx) => Promise<void>, sql: string) =>
      rolledBack(async (tx) => {
        await setup(tx);
        await tx.query(sql);
        const audit = await tx.query<{ details: Record<string, unknown> }>(
          `select details from audit_log
          where details->>'type' = 'migration_record_reconciled' order by created_at desc limit 1`
        );
        return audit.rows[0]?.details;
      });
    const message = (r: unknown) =>
      r instanceof Error ? r.message : `ran: ${JSON.stringify(r)}`;
    const none = async () => undefined;

    it("retires a record with no checksum, keeping it whole in the audit record", async () => {
      const r = await rolledBack(async (tx) => {
        await tx.query(
          "insert into applied_migrations (filename, confidence, note) values ('999_withdrawn.sql', 'verified', 'x')"
        );
        await tx.query(procedure("retire", "999_withdrawn.sql", REASON));
        const left = await tx.query(
          "select 1 from applied_migrations where filename = '999_withdrawn.sql'"
        );
        const [recorded] = CHECK.split(/;\s*\n/)
          .map((q) =>
            q.trim().replace(/REPLACE-WITH-THE-FILE-NAME\.sql/, "999_withdrawn.sql")
          )
          .filter((q) => q.length > 0);
        const check = await tx.query<{ recorded: string }>(recorded);
        const audit = await tx.query<{ details: Record<string, unknown> }>(
          "select details from audit_log where details->>'filename' = '999_withdrawn.sql'"
        );
        return {
          left: left.rows.length,
          check: check.rows[0].recorded,
          audit: audit.rows,
        };
      });
      if (r instanceof Error) throw r;
      expect(r.left).toBe(0);
      expect(r.check).toBe("0");
      expect(r.audit).toEqual([
        {
          details: expect.objectContaining({
            type: "migration_record_reconciled",
            reconciliation: "retire",
            filename: "999_withdrawn.sql",
            reason: REASON,
            procedure: "TENANCY_OPERATIONS: reconciling the migration record",
            record: expect.objectContaining({
              filename: "999_withdrawn.sql",
              confidence: "verified",
            }),
          }),
        },
      ]);
    });

    it("records a file applied without its record, as assumed", async () => {
      const r = await rolledBack(async (tx) => {
        await tx.query(procedure("record", "998_applied_by_hand.sql", REASON));
        return (
          await tx.query<{ confidence: string; note: string }>(
            "select confidence, note from applied_migrations where filename = '998_applied_by_hand.sql'"
          )
        ).rows;
      });
      if (r instanceof Error) throw r;
      expect(r).toEqual([
        { confidence: "assumed", note: expect.stringContaining(REASON) },
      ]);
    });

    it.each([
      ["the placeholders left", procedure(null, null, null), /replace the action/],
      ["another action", procedure("delete", "997_x.sql", REASON), /retire or record/],
      [
        "a name that is no migration's",
        procedure("record", "drop table users", REASON),
        /not a migration file name/,
      ],
      [
        "the baseline's record",
        procedure("retire", "000_baseline.sql", REASON),
        /never reconciled/,
      ],
      [
        "a reason that is not a sentence",
        procedure("record", "996_x.sql", "because"),
        /reason in a sentence/,
      ],
      [
        "a record that does not exist",
        procedure("retire", "995_absent.sql", REASON),
        /no record of/,
      ],
    ])("refuses %s", async (_label, sql, expected) => {
      expect(message(await run(none, sql))).toMatch(expected);
    });

    it("refuses to retire a record with its checksum (its file exists), and to record a file twice", async () => {
      expect(
        message(
          await run(
            none,
            procedure("retire", "063_applied_migrations_checksum.sql", REASON)
          )
        )
      ).toMatch(/records its checksum/);
      expect(
        message(
          await run(
            none,
            procedure("record", "063_applied_migrations_checksum.sql", REASON)
          )
        )
      ).toMatch(/already recorded/);
    });
  }
);
