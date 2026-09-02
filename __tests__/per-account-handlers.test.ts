/**
 * __tests__/per-account-handlers.test.ts — U6 per-account handler tests (Sprint 3c).
 */

import {
  handleBlockUserFeature,
  handleUnblockUserFeature,
} from "@/app/api/admin/ai/handlers/restrictions";

const upsert = jest.fn();
const eq1 = jest.fn();
const eq2 = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: () => ({
    from: () => ({
      upsert: (...a: unknown[]) => upsert(...a),
      delete: () => ({ eq: (...a: unknown[]) => eq1(...a) }),
    }),
  }),
}));
const writeAuditLog = jest.fn();
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: (...a: unknown[]) => writeAuditLog(...a),
}));

const ACTOR = "admin-1";
const USER = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  upsert.mockReset();
  eq1.mockReset();
  eq2.mockReset();
  writeAuditLog.mockReset();
  upsert.mockResolvedValue({ error: null });
  // delete().eq().eq() chain: first eq returns an object with a second eq that resolves.
  eq1.mockReturnValue({ eq: (...a: unknown[]) => eq2(...a) });
  eq2.mockResolvedValue({ error: null });
  writeAuditLog.mockResolvedValue(undefined);
});

describe("handleBlockUserFeature", () => {
  it("upserts a block and audits", async () => {
    const r = await handleBlockUserFeature(
      { user_id: USER, feature: "agent_delegate", reason: "abuse" },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER,
        feature: "agent_delegate",
        reason: "abuse",
        created_by: ACTOR,
      }),
      { onConflict: "user_id,feature" }
    );
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
  it("requires user_id and feature", async () => {
    expect((await handleBlockUserFeature({ feature: "x" }, ACTOR)).success).toBe(false);
    expect((await handleBlockUserFeature({ user_id: USER }, ACTOR)).success).toBe(false);
  });
  it("returns the DB error", async () => {
    upsert.mockResolvedValue({ error: { message: "boom" } });
    const r = await handleBlockUserFeature({ user_id: USER, feature: "x" }, ACTOR);
    expect(r.success).toBe(false);
    expect(r.error).toBe("boom");
  });
});

describe("handleUnblockUserFeature", () => {
  it("deletes the block and audits", async () => {
    const r = await handleUnblockUserFeature(
      { user_id: USER, feature: "agent_delegate" },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(eq1).toHaveBeenCalledWith("user_id", USER);
    expect(eq2).toHaveBeenCalledWith("feature", "agent_delegate");
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
  it("requires both fields", async () => {
    expect((await handleUnblockUserFeature({ user_id: USER }, ACTOR)).success).toBe(
      false
    );
  });
});
