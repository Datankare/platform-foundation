/**
 * @jest-environment node
 */
/**
 * The validated config write with the real audit log, on Postgres (audit X-8)
 *
 * The change is validated, recorded in the audit log before it is made, then made together with
 * its history record (one transaction). With no audit record the value does not change; an
 * unknown key is never created; a failed write is recorded as failed and changes nothing.
 * (Layering and tenancy of config: __tests__/db/platform-config.db.test.ts.)
 *
 * The suite's key is its own (random name), removed afterwards.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// platform/data as it is, except that a test can make the owner transaction's history insert
// fail, as an outage mid-transaction would.
let mockFailHistory = false;
jest.mock("@/platform/data", () => {
  const actual = jest.requireActual("@/platform/data");
  return {
    ...actual,
    withOwnerTx: (purpose: string, fn: (tx: unknown) => Promise<unknown>) =>
      actual.withOwnerTx(
        purpose,
        (tx: { query: (...a: unknown[]) => Promise<unknown> }) =>
          fn(
            mockFailHistory
              ? {
                  ...tx,
                  query: (text: string, values?: unknown[]) =>
                    /insert into platform_config_history/.test(text)
                      ? Promise.reject(
                          new Error("platform_config_history is unavailable")
                        )
                      : tx.query(text, values),
                }
              : tx
          )
      ),
  };
});

import { randomUUID } from "node:crypto";
import { withOwnerTx } from "@/platform/data";
import { runWithTenant } from "@/platform/tenancy/context";
import { clearConfigCache, setConfigWithHistory } from "@/platform/auth/platform-config";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const KEY = `test.${randomUUID().slice(0, 8)}.rpm`;
const ADMIN: string = randomUUID();
let t: TestTenant;

async function q<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<R[]> {
  return (await withOwnerTx("operator", (tx) => tx.query<R>(text, values))).rows;
}
const value = async () =>
  (
    await q<{ value: unknown }>("select value from platform_config where key = $1", [KEY])
  )[0].value;
const history = () =>
  q<{ previous_value: unknown; new_value: unknown }>(
    "select previous_value, new_value from platform_config_history where config_key = $1",
    [KEY]
  );
const audit = () =>
  q<{
    action: string;
    actor_id: string;
    details: Record<string, unknown>;
    created_at: Date;
  }>(
    "select action, actor_id, details, created_at from audit_log where tenant_id = $1::uuid and details->>'key' = $2 order by created_at, id",
    [t.id, KEY]
  );
/** As a single-tenant deployment's administrator: the platform default, as before tenancy. */
const set = (v: unknown, actor = ADMIN) =>
  runWithTenant({ tenantId: t.id, mode: "single" }, () =>
    setConfigWithHistory(KEY, v, actor, "load test")
  );

dbDescribe("setConfigWithHistory", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    await q(
      `insert into platform_config
         (key, value, default_value, description, category, value_type, permission_tier, min_value, max_value)
       values ($1, '100', '100', 'Rate limit', 'test', 'number', 'standard', '10', '1000')`,
      [KEY]
    );
  });

  afterAll(async () => {
    await q("delete from platform_config_history where config_key = $1", [KEY]);
    await q("delete from platform_config where key = $1", [KEY]);
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  beforeEach(async () => {
    mockFailHistory = false;
    clearConfigCache();
    await q("update platform_config set value = '100' where key = $1", [KEY]);
    await q("delete from platform_config_history where config_key = $1", [KEY]);
    await q("delete from audit_log where tenant_id = $1::uuid", [t.id]);
  });

  it("records, then changes and writes history", async () => {
    const result = await set(200);
    expect(result).toEqual({ success: true, historyWriteFailed: false });
    // Stored as JSON, not JSON text: a stringified value read back as "200" (release review).
    expect(await value()).toBe(200);
    expect(await history()).toEqual([{ previous_value: 100, new_value: 200 }]);
    const [record] = await audit();
    expect(record).toMatchObject({
      action: "admin_action",
      actor_id: ADMIN,
      details: expect.objectContaining({
        type: "config_updated_with_history",
        previousValue: 100,
        newValue: 200,
        outcome: "attempted",
      }),
    });
    const [{ updated_at }] = await q<{ updated_at: Date }>(
      "select updated_at from platform_config where key = $1",
      [KEY]
    );
    expect(record.created_at.getTime()).toBeLessThanOrEqual(updated_at.getTime());
  });

  it("does not change the value when the audit log is unavailable", async () => {
    // An actor id the audit log refuses: the record cannot be written.
    const result = await set(200, "not-a-user-id");
    expect(result.success).toBe(false);
    expect(await value()).toBe(100);
    expect(await history()).toEqual([]);
  });

  it("refuses a value outside the key's range and writes nothing", async () => {
    const result = await set(5);
    expect(result.success).toBe(false);
    expect(result.validationErrors?.length).toBeGreaterThan(0);
    expect(await audit()).toEqual([]);
    expect(await value()).toBe(100);
  });

  it("never creates an unknown key", async () => {
    const unknown = `${KEY}.made-up`;
    const result = await runWithTenant({ tenantId: t.id, mode: "single" }, () =>
      setConfigWithHistory(unknown, 1, ADMIN, "x")
    );
    expect(result.success).toBe(false);
    expect(await q("select 1 from platform_config where key = $1", [unknown])).toEqual(
      []
    );
  });

  it("a failed history write undoes the change, and the attempt is recorded as failed", async () => {
    mockFailHistory = true;
    const result = await set(200);
    expect(result.success).toBe(false);
    expect(await value()).toBe(100);
    expect((await audit()).map((r) => r.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });
});
