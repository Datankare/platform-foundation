/**
 * platform/admin/__tests__/approve-and-apply.test.ts — an approved change is applied, or reopened
 *
 * Release review (Sprint 7X): an approval was marked approved before the change was applied; when
 * the apply failed, the change was left approved, never applied, and impossible to approve again.
 * approveAndApply makes them one outcome. Real module over an in-memory database.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigOrThrow: jest.fn().mockResolvedValue(true),
}));
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { approveAndApply } from "../config-approval";
import { FakeDatabase } from "@/__tests__/helpers/fake-database";

const REQUESTER = "00000000-0000-4000-8000-00000000e001";
const REVIEWER = "00000000-0000-4000-8000-00000000e002";
let db: FakeDatabase;

beforeEach(() => {
  db = new FakeDatabase({
    config_pending_approvals: [
      {
        id: "apr-1",
        config_key: "rate_limit_rpm",
        current_value: 100,
        proposed_value: 200,
        requested_by: REQUESTER,
        change_comment: "load",
        impact_summary: null,
        status: "pending",
        reviewed_by: null,
        review_comment: null,
        reviewed_at: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: "2026-10-22T00:00:00Z",
      },
    ],
  });
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
});

const row = () => db.rows("config_pending_approvals")[0];

it("approves and applies, passing the stored value as it is", async () => {
  const apply = jest.fn(async () => ({ success: true }));
  const res = await approveAndApply("apr-1", REVIEWER, "ok", apply);
  expect(res.success).toBe(true);
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ proposedValue: 200 }));
  expect(row()).toMatchObject({ status: "approved", reviewed_by: REVIEWER });
});

it("reopens the approval when the change cannot be applied", async () => {
  const res = await approveAndApply("apr-1", REVIEWER, "ok", async () => ({
    success: false,
    error: "db down",
  }));
  expect(res).toMatchObject({ success: false, errorCode: "service.unavailable" });
  expect(row()).toMatchObject({
    status: "pending",
    reviewed_by: null,
    reviewed_at: null,
  });
  // …so it can be approved again once the cause is fixed.
  const again = await approveAndApply("apr-1", REVIEWER, "retry", async () => ({
    success: true,
  }));
  expect(again.success).toBe(true);
});

it("applies nothing on a self-approval", async () => {
  const apply = jest.fn();
  const res = await approveAndApply("apr-1", REQUESTER, "mine", apply);
  expect(res).toMatchObject({ success: false, errorCode: "approvals.self_approval" });
  expect(apply).not.toHaveBeenCalled();
  expect(row().status).toBe("pending");
});
