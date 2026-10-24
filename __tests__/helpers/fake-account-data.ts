/**
 * __tests__/helpers/fake-account-data.ts — platform/data over a FakeDatabase, for unit tests of
 * the moderation account-status paths (review-service overturn, Sentinel status changes)
 *
 * `jest.mock("@/platform/data", () => require("@/__tests__/helpers/fake-account-data")
 *   .fakeAccountData(() => mockDb))` runs each statement those paths issue against the
 * FakeDatabase's `users` and `audit_log` rows, through its client — so its injected failures
 * (failReads / failWrites) and its write log apply, in order with writes other modules make
 * through the same FakeDatabase. Any other statement is an error: the real SQL is proved by
 * __tests__/db/moderation-account-status.db.test.ts, not here.
 */

import type { FakeDatabase, Row } from "./fake-database";

type DataModule = typeof import("@/platform/data");

interface Result {
  data: Row[] | Row | null;
  error: { message: string; code?: string } | null;
}

async function run(q: PromiseLike<Result>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  if (data === null) return [];
  return Array.isArray(data) ? data : [data];
}

/** Columns and the $n each takes, from `insert into t (a, b) values ($1, $2::x)`. */
function insertRow(sql: string, values: readonly unknown[]): Row | null {
  const m = /insert into audit_log\s*\(([^)]*)\)\s*values\s*\(([\s\S]*)\)/i.exec(sql);
  if (!m) return null;
  const cols = m[1].split(",").map((c) => c.trim());
  const params = m[2].split(",").map((p) => p.trim());
  const row: Row = {};
  cols.forEach((col, i) => {
    const n = /^\$(\d+)/.exec(params[i] ?? "");
    let v: unknown = n ? values[Number(n[1]) - 1] : null;
    if (col === "details" && typeof v === "string") v = JSON.parse(v);
    row[col] = v;
  });
  return row;
}

export function fakeAccountData(db: () => FakeDatabase): Partial<DataModule> {
  const actual = jest.requireActual<DataModule>("@/platform/data");

  async function query(text: string, values: readonly unknown[] = []) {
    const sql = text.replace(/\s+/g, " ").trim();
    const from = (t: string) => db().client().from(t);
    let rows: Row[];

    if (
      /^select account_status from users where id = \$1::uuid(?: for update)?$/.test(sql)
    ) {
      rows = await run(from("users").select("account_status").eq("id", values[0]));
    } else if (/^select details from audit_log where target_id = \$1::uuid/.test(sql)) {
      rows = await run(
        from("audit_log")
          .select("details, created_at")
          .eq("target_id", values[0])
          .eq("action", "admin_action")
          .order("created_at", { ascending: false })
          .limit(200)
      );
    } else if (
      /^update users set account_status = \$2::account_status, banned_at = null/.test(sql)
    ) {
      // Overturn: restore, keeping an end date only when restoring into that status.
      const to = values[1] as string;
      const patch: Row = {
        account_status: to,
        banned_at: null,
        ban_reason: null,
        status_changed_by: values[2],
        status_changed_at: new Date().toISOString(),
      };
      if (to !== "suspended") patch.suspended_until = null;
      if (to !== "restricted") patch.restricted_until = null;
      rows = await run(from("users").update(patch).eq("id", values[0]));
    } else if (
      /^update users set account_status = \$2::account_status, status_changed_by = \$3/.test(
        sql
      )
    ) {
      // Sentinel: set the status; a suspension's end, or a ban, only when given.
      const now = new Date().toISOString();
      const patch: Row = {
        account_status: values[1],
        status_changed_by: values[2],
        status_changed_at: now,
      };
      if (values[3] !== null) patch.suspended_until = values[3];
      if (values[4] === true)
        Object.assign(patch, { banned_at: now, ban_reason: values[5] });
      rows = await run(from("users").update(patch).eq("id", values[0]));
    } else {
      const row = insertRow(sql, values);
      if (!row) throw new Error(`fake-account-data: unexpected SQL: ${sql}`);
      rows = await run(from("audit_log").insert(row));
    }
    return { rows, rowCount: rows.length };
  }

  return {
    ...actual,
    hasDatabase: () => true,
    withTenantTx: (async (fn: Parameters<DataModule["withTenantTx"]>[0]) =>
      fn({ tenantId: undefined, query } as never)) as DataModule["withTenantTx"],
  };
}
