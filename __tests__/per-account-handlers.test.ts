/**
 * __tests__/per-account-handlers.test.ts — U6 per-account handler tests (Sprint 3c)
 *
 * Against an in-memory database (helpers/fake-database.ts) with the real audit module: each
 * block or unblock is recorded before it is made, and is not made when the record cannot be
 * written (audit X-8).
 */

import {
  handleBlockUserFeature,
  handleUnblockUserFeature,
} from "@/app/api/admin/ai/handlers/restrictions";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { FakeDatabase } from "./helpers/fake-database";

jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));

const ACTOR = "00000000-0000-4000-8000-00000000a001";
const USER = "11111111-1111-4111-8111-111111111111";
let db: FakeDatabase;

beforeEach(() => {
  db = new FakeDatabase({ user_feature_restrictions: [], audit_log: [] });
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
});

describe("handleBlockUserFeature", () => {
  it("records, then blocks the feature", async () => {
    const r = await handleBlockUserFeature(
      { user_id: USER, feature: "agent_delegate", reason: "abuse" },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(db.rows("user_feature_restrictions")).toEqual([
      expect.objectContaining({
        user_id: USER,
        feature: "agent_delegate",
        reason: "abuse",
        created_by: ACTOR,
      }),
    ]);
    expect(db.writes.map(([op, table]) => `${op} ${table}`)).toEqual([
      "insert audit_log",
      "upsert user_feature_restrictions",
    ]);
    expect(db.rows("audit_log")[0]).toMatchObject({ actor_id: ACTOR, target_id: USER });
  });

  it("is idempotent: blocking twice leaves one block", async () => {
    await handleBlockUserFeature({ user_id: USER, feature: "x" }, ACTOR);
    await handleBlockUserFeature({ user_id: USER, feature: "x" }, ACTOR);
    expect(db.rows("user_feature_restrictions")).toHaveLength(1);
  });

  it("requires user_id and feature", async () => {
    expect((await handleBlockUserFeature({ feature: "x" }, ACTOR)).success).toBe(false);
    expect((await handleBlockUserFeature({ user_id: USER }, ACTOR)).success).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it("returns the database error, and records that the block failed", async () => {
    db.failWrites("user_feature_restrictions");
    const r = await handleBlockUserFeature({ user_id: USER, feature: "x" }, ACTOR);
    expect(r).toMatchObject({
      success: false,
      error: "user_feature_restrictions is unavailable",
    });
    expect(db.rows("audit_log").map((row) => row.details.outcome)).toEqual([
      "attempted",
      "failed",
    ]);
  });

  it("does not block when the audit log is unavailable", async () => {
    db.failWrites("audit_log");
    const r = await handleBlockUserFeature({ user_id: USER, feature: "x" }, ACTOR);
    expect(r).toMatchObject({ success: false, code: "service.unavailable" });
    expect(db.rows("user_feature_restrictions")).toEqual([]);
  });
});

describe("handleUnblockUserFeature", () => {
  beforeEach(() => {
    db.rows("user_feature_restrictions").push(
      { user_id: USER, feature: "agent_delegate" },
      { user_id: USER, feature: "translate" }
    );
  });

  it("removes only that block", async () => {
    const r = await handleUnblockUserFeature(
      { user_id: USER, feature: "agent_delegate" },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(db.rows("user_feature_restrictions")).toEqual([
      { user_id: USER, feature: "translate" },
    ]);
  });

  it("requires both fields", async () => {
    expect((await handleUnblockUserFeature({ user_id: USER }, ACTOR)).success).toBe(
      false
    );
  });

  it("does not unblock when the audit log is unavailable", async () => {
    db.failWrites("audit_log");
    const r = await handleUnblockUserFeature(
      { user_id: USER, feature: "agent_delegate" },
      ACTOR
    );
    expect(r.success).toBe(false);
    expect(db.rows("user_feature_restrictions")).toHaveLength(2);
  });
});

describe("hostile input", () => {
  it.each(["u1", "x,feature.neq.null", "*", 7])(
    "refuses the user id %p",
    async (userId) => {
      const r = await handleBlockUserFeature({ user_id: userId, feature: "x" }, ACTOR);
      expect(r.success).toBe(false);
      expect(db.writes).toEqual([]);
    }
  );
});

describe("no self-targeting (release review, Sprint 7X)", () => {
  it.each([
    ["block", handleBlockUserFeature],
    ["unblock", handleUnblockUserFeature],
  ] as const)(
    "refuses to %s a feature on the administrator's own account",
    async (_l, fn) => {
      const r = await fn({ user_id: ACTOR, feature: "translate" }, ACTOR);
      expect(r).toMatchObject({ success: false, code: "admin.self_target" });
    }
  );
});
