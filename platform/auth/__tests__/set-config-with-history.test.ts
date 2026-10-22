/**
 * platform/auth/__tests__/set-config-with-history.test.ts — the validated config write
 *
 * Against an in-memory database with the real audit module: the change is validated, recorded
 * in the audit log before it is made, made, and recorded in config history. With no audit record
 * the value does not change (audit X-8); an unknown key is never created.
 */

jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { clearConfigCache, setConfigWithHistory } from "@/platform/auth/platform-config";
import { FakeDatabase } from "@/__tests__/helpers/fake-database";

const ADMIN = "00000000-0000-4000-8000-00000000a001";
let db: FakeDatabase;

beforeEach(() => {
  clearConfigCache();
  db = new FakeDatabase({
    platform_config: [
      {
        key: "rate_limit_rpm",
        value: 100,
        description: "Rate limit",
        category: "system",
        updated_at: "2026-04-22T00:00:00Z",
        default_value: 100,
        value_type: "number",
        min_value: 10,
        max_value: 1000,
        allowed_values: null,
        permission_tier: "standard",
      },
    ],
    platform_config_history: [],
    audit_log: [],
  });
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
});

const value = () => db.rows("platform_config")[0].value;

describe("setConfigWithHistory", () => {
  it("records, changes, and writes history — in that order", async () => {
    const result = await setConfigWithHistory("rate_limit_rpm", 200, ADMIN, "load test");
    expect(result).toEqual({ success: true, historyWriteFailed: false });
    // Stored as JSON, not JSON text: a stringified value read back as "200" (release review).
    expect(value()).toBe(200);
    expect(db.rows("platform_config_history")[0]).toMatchObject({
      previous_value: 100,
      new_value: 200,
    });
    expect(db.writes.map(([op, table]) => `${op} ${table}`)).toEqual([
      "insert audit_log",
      "update platform_config",
      "insert platform_config_history",
    ]);
    expect(db.rows("audit_log")[0]).toMatchObject({
      action: "admin_action",
      actor_id: ADMIN,
      details: expect.objectContaining({
        type: "config_updated_with_history",
        key: "rate_limit_rpm",
        previousValue: 100,
        newValue: 200,
        outcome: "attempted",
      }),
    });
  });

  it("does not change the value when the audit log is unavailable", async () => {
    db.failWrites("audit_log");
    const result = await setConfigWithHistory("rate_limit_rpm", 200, ADMIN, "x");
    expect(result.success).toBe(false);
    expect(value()).toBe(100);
    expect(db.rows("platform_config_history")).toHaveLength(0);
  });

  it("refuses a value outside the key's range and writes nothing", async () => {
    const result = await setConfigWithHistory("rate_limit_rpm", 5, ADMIN, "x");
    expect(result.success).toBe(false);
    expect(result.validationErrors?.length).toBeGreaterThan(0);
    expect(db.writes).toEqual([]);
  });

  it("never creates an unknown key", async () => {
    const result = await setConfigWithHistory("made.up", 1, ADMIN, "x");
    expect(result.success).toBe(false);
    expect(db.rows("platform_config")).toHaveLength(1);
    expect(db.writes).toEqual([]);
  });

  it("reports a failed history write, and records the update as done", async () => {
    db.failWrites("platform_config_history");
    const result = await setConfigWithHistory("rate_limit_rpm", 200, ADMIN, "x");
    expect(result).toEqual({ success: true, historyWriteFailed: true });
    expect(value()).toBe(200);
  });

  it("records a failed update as failed", async () => {
    db.failWrites("platform_config");
    const result = await setConfigWithHistory("rate_limit_rpm", 200, ADMIN, "x");
    expect(result.success).toBe(false);
    expect(db.rows("audit_log").map((r) => r.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });
});
