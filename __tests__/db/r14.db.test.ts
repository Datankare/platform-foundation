/**
 * __tests__/db/r14.db.test.ts — Review 14 on Postgres
 *
 *   L-3  an approval row a concurrent reviewer holds is skipped by the withdrawal (`skip locked`):
 *        it is now counted and reported — `incomplete`, `remaining`, the alert
 *        `approvals.withdrawal_incomplete` — and still refuses stale (ported from the reviewer's
 *        proof, which showed it left pending with `incomplete: false` and no alert);
 *   L-4  a platform-scope reduction withdraws the platform-scope approvals of the key in EVERY
 *        tenant holding one, each audited in that tenant's own log — never only the current one;
 *   M-1  every DB test runs under the 30 s bound (helpers/db.ts, jest.setup.ts), not jest's 5 s.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
const raiseAlert = jest.fn();
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
}));

import { Client } from "pg";
import { withOwnerTx } from "@/platform/data";
import {
  requestApproval,
  withdrawPendingApprovalsForKey,
} from "@/platform/admin/config-approval";
import { withdrawSupersededHolds } from "@/platform/admin/hold-withdrawal";
import { clearConfigCache } from "@/platform/auth/platform-config";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  DB_TEST_TIMEOUT_MS,
  type TestTenant,
} from "../helpers/db";

let t: TestTenant;
if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
    raiseAlert.mockReset();
  });
}
const owner = <R = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  withOwnerTx("operator", async (tx) => (await tx.query(text, values)).rows as R[]);

const withKey = (key: () => string) => {
  beforeEach(async () => {
    await owner(
      `insert into platform_config (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
       values ($1, '1'::jsonb, '1'::jsonb, 'rev14', 'test', 'number', 'safety', true)`,
      [key()]
    );
  });
  afterEach(async () => {
    await owner("delete from config_pending_approvals where config_key = $1", [key()]);
    await owner("delete from platform_config where key = $1", [key()]);
    clearConfigCache();
  });
};

dbDescribe("R14-M1 the DB tests' bound", () => {
  it("is 30 s for every test under __tests__/db (not jest's default 5 s)", () => {
    expect(DB_TEST_TIMEOUT_MS).toBe(30_000);
    const set = (globalThis as Record<symbol, unknown>)[
      Symbol.for("TEST_TIMEOUT_SYMBOL")
    ];
    expect(set).toBe(DB_TEST_TIMEOUT_MS);
  });
});

dbDescribe("R14-L3 a withdrawal never leaves a locked approval unreported", () => {
  const KEY = () => `rev14.skip.${t.id}`;
  withKey(KEY);

  it("a row locked by a concurrent reviewer is skipped — and counted: incomplete, remaining 1, alerted; still pending", async () => {
    const requester = await t.user("req");
    const a = await t.run(() =>
      requestApproval({
        configKey: KEY(),
        currentValue: 1,
        proposedValue: 5,
        requestedBy: requester,
        changeComment: "raise",
        scope: "tenant",
      })
    );
    const id = a.record!.id;
    // A concurrent reviewer holds the row (approveChange's `for update`).
    const locker = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await locker.connect();
    let direct: { withdrawn: string[]; incomplete: boolean; remaining: number };
    let full: Awaited<ReturnType<typeof withdrawSupersededHolds>>;
    try {
      await locker.query("begin");
      await locker.query(
        "select 1 from config_pending_approvals where id = $1 for update",
        [id]
      );
      direct = await t.run(() =>
        withdrawPendingApprovalsForKey(
          KEY(),
          requester,
          "kill switch",
          "kill switch",
          "tenant"
        )
      );
      full = await t.run(() =>
        withdrawSupersededHolds(KEY(), requester, "kill switch", "tenant")
      );
    } finally {
      await locker.query("rollback"); // the reviewer's decision was refused: the row is unchanged
      await locker.end();
    }
    expect(direct).toEqual({ withdrawn: [], incomplete: true, remaining: 1 });
    expect(full.approvals).toEqual([]);
    expect(full.remaining).toBe(1);
    const alerts = raiseAlert.mock.calls.filter(
      ([x]) => (x as { name: string }).name === "approvals.withdrawal_incomplete"
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0][0]).toMatchObject({ tags: { key: KEY(), remaining: "1" } });
    expect(alerts[0][0].message).toMatch(/held by a concurrent reviewer/);
    expect(alerts[0][0].message).toMatch(/refuses as stale/);
    const [row] = await owner<{ status: string }>(
      "select status::text as status from config_pending_approvals where id = $1",
      [id]
    );
    expect(row.status).toBe("pending");
    // Unlocked, the next withdrawal takes it, and reports nothing left.
    const again = await t.run(() =>
      withdrawPendingApprovalsForKey(KEY(), requester, "again", "again", "tenant")
    );
    expect(again).toEqual({ withdrawn: [id], incomplete: false, remaining: 0 });
  });

  it("an approval requested after the withdrawal began is not counted as left", async () => {
    const requester = await t.user("req");
    const out = await t.run(() =>
      withdrawPendingApprovalsForKey(KEY(), requester, "n", "n", "tenant")
    );
    expect(out).toEqual({ withdrawn: [], incomplete: false, remaining: 0 });
  });
});

dbDescribe("R14-L4 a platform-scope withdrawal reaches every tenant", () => {
  const KEY = () => `rev14.platform.${t.id}`;
  withKey(KEY);

  it("withdraws the platform-scope approvals of other tenants, each audited in its own tenant; tenant-scope ones stand", async () => {
    const other = await createTestTenant();
    const third = await createTestTenant();
    const operatorUser = await t.user("operator");
    const otherRequester = await other.user("req");
    const thirdRequester = await third.user("req");
    const mine = await t.run(() =>
      requestApproval({
        configKey: KEY(),
        currentValue: 1,
        proposedValue: 7,
        requestedBy: operatorUser,
        changeComment: "platform raise, here",
        scope: "platform",
      })
    );
    const theirs = await other.run(() =>
      requestApproval({
        configKey: KEY(),
        currentValue: 1,
        proposedValue: 9,
        requestedBy: otherRequester,
        changeComment: "platform raise, elsewhere",
        scope: "platform",
      })
    );
    const tenantScoped = await third.run(() =>
      requestApproval({
        configKey: KEY(),
        currentValue: 1,
        proposedValue: 3,
        requestedBy: thirdRequester,
        changeComment: "the tenant's own value",
        scope: "tenant",
      })
    );
    const out = await t.run(() =>
      withdrawSupersededHolds(KEY(), operatorUser, "platform default reduced", "platform")
    );
    expect([...out.approvals].sort()).toEqual(
      [mine.record!.id, theirs.record!.id].sort()
    );
    expect(out.tenants).toEqual([other.id]);
    expect(out.remaining).toBe(0);
    expect(out.failed).toEqual([]);
    const status = async (id: string) =>
      (
        await owner<{ status: string }>(
          "select status::text as status from config_pending_approvals where id = $1",
          [id]
        )
      )[0].status;
    expect(await status(mine.record!.id)).toBe("rejected");
    expect(await status(theirs.record!.id)).toBe("rejected");
    expect(await status(tenantScoped.record!.id)).toBe("pending");
    // Audited in the tenant whose approval it withdrew.
    const records = await owner<{ tenant_id: string; ids: string[] }>(
      `select tenant_id::text as tenant_id, details->'holdIds' as ids from audit_log
        where details->>'type' = 'approval_withdrawn' and details->>'key' = $1
        order by tenant_id`,
      [KEY()]
    );
    expect(records.map((r) => [r.tenant_id, r.ids]).sort()).toEqual(
      [
        [t.id, [mine.record!.id]],
        [other.id, [theirs.record!.id]],
      ].sort()
    );
    expect(
      raiseAlert.mock.calls.filter(
        ([x]) => (x as { name: string }).name === "approvals.withdrawal_incomplete"
      )
    ).toEqual([]);
  });

  it("a tenant-scope reduction stays in the current tenant", async () => {
    const other = await createTestTenant();
    const otherRequester = await other.user("req");
    const theirs = await other.run(() =>
      requestApproval({
        configKey: KEY(),
        currentValue: 1,
        proposedValue: 9,
        requestedBy: otherRequester,
        changeComment: "platform raise, elsewhere",
        scope: "platform",
      })
    );
    const actor = await t.user("admin");
    const out = await t.run(() =>
      withdrawSupersededHolds(KEY(), actor, "tenant value reduced", "tenant")
    );
    expect(out.tenants).toEqual([]);
    const [row] = await owner<{ status: string }>(
      "select status::text as status from config_pending_approvals where id = $1",
      [theirs.record!.id]
    );
    expect(row.status).toBe("pending");
  });
});
