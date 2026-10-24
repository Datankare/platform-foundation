/**
 * __tests__/moderation-appeals-routes.test.ts
 *
 * Route-integrity tests for the appeals API:
 *   POST   /api/moderation/appeals        — user submits an appeal
 *   PATCH  /api/moderation/appeals/[id]   — moderator claims/unclaims/resolves
 *
 * Services and stores are mocked; token verification and the admin guard run with real roles
 * (helpers/test-identities.ts). These verify the security-critical
 * route logic: token-derived identity, server-side decision fetch + ownership
 * check (no cross-user appeals), F1 previousStatus derivation, appeal-scoping,
 * RBAC gating, status mapping, and error paths.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-req-id"),
}));

jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/test-identities").mockMiddleware()
);
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);

jest.mock("@/platform/moderation/store", () => ({
  getModerationStore: jest.fn(),
}));

jest.mock("@/platform/auth/audit", () => ({
  getAuditLogForUser: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/platform/moderation/review-service", () => ({
  submitAppeal: jest.fn(),
  claimItem: jest.fn(),
  unclaimItem: jest.fn(),
  resolveItem: jest.fn(),
}));

jest.mock("@/platform/moderation/review-store", () => ({
  getReviewQueueStore: jest.fn(),
}));

// The appellant lookup reads through a fake platform/data (helpers/fake-data.ts); its SQL and
// tenancy are proved in __tests__/db/admin-tenant-data.db.test.ts.
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { getModerationStore } from "@/platform/moderation/store";
import { getAuditLogForUser } from "@/platform/auth/audit";
import {
  submitAppeal,
  claimItem,
  unclaimItem,
  resolveItem,
} from "@/platform/moderation/review-service";
import { getReviewQueueStore } from "@/platform/moderation/review-store";
import { POST } from "@/app/api/moderation/appeals/route";
import { fakeData } from "./helpers/fake-data";
import { PATCH } from "@/app/api/moderation/appeals/[id]/route";

// ── Helpers ─────────────────────────────────────────────────────────────

const mockQueryAudits = jest.fn();
const mockGetById = jest.fn();

const REVIEWER = CALLERS.moderator.userId;

function postReq(body: unknown, caller: CallerName = "free"): NextRequest {
  return new NextRequest("http://localhost/api/moderation/appeals", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authAs(caller) },
    body: JSON.stringify(body),
  });
}

function patchReq(body: unknown, caller: CallerName = "moderator"): NextRequest {
  return new NextRequest("http://localhost/api/moderation/appeals/a1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authAs(caller) },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeAuditRecord(overrides: Record<string, unknown> = {}) {
  return {
    inputHash: "hash",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    userId: "u-app",
    triggeredBy: "classifier",
    categoriesFlagged: ["violence"],
    confidence: 0.9,
    severity: "high",
    actionTaken: "block",
    reasoning: "Blocked for test.",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-1",
    agentId: "guardian-1",
    pipelineLatencyMs: 120,
    requestId: "req-orig",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const GOOD_REASON = "I was translating a historical document about a conflict.";

beforeEach(() => {
  jest.clearAllMocks();
  (getModerationStore as jest.Mock).mockReturnValue({ queryAudits: mockQueryAudits });
  (getReviewQueueStore as jest.Mock).mockReturnValue({ getById: mockGetById });
  (getAuditLogForUser as jest.Mock).mockResolvedValue([]);
  fakeData().reset();
  fakeData().answer = (sql) =>
    sql.startsWith("select id from users where cognito_sub")
      ? [{ id: "u-app" }]
      : undefined;
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/moderation/appeals
// ═══════════════════════════════════════════════════════════════════════

describe("POST /api/moderation/appeals", () => {
  it("submits a valid appeal for the user's own decision", async () => {
    mockQueryAudits.mockResolvedValue([makeAuditRecord({ userId: "u-app" })]);
    (submitAppeal as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "appeal-1", source: "appeal" },
    });

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.item.id).toBe("appeal-1");
    expect(submitAppeal).toHaveBeenCalledWith(
      expect.objectContaining({
        originalDecisionId: "traj-1",
        appealingUserId: "u-app",
        appealReason: GOOD_REASON,
      }),
      expect.any(String)
    );
  });

  it.each([
    ["null", null, "request.invalid_body"],
    ["an array", [], "request.invalid_body"],
    [
      "a non-string decision id",
      { originalDecisionId: 5, appealReason: GOOD_REASON },
      "request.missing_fields",
    ],
  ])(
    "answers %s with a coded 400, not a crash (found by the monkey run)",
    async (_label, body, code) => {
      const res = await POST(postReq(body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(code);
      expect(submitAppeal).not.toHaveBeenCalled();
    }
  );

  it("returns the auth error when unauthenticated", async () => {
    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON }, "anonymous")
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 when fields are missing", async () => {
    const res = await POST(postReq({ originalDecisionId: "traj-1" }));

    expect(res.status).toBe(400);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("returns 403 when the user account cannot be resolved", async () => {
    fakeData().answer = () => [];

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(403);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lookup cannot be read", async () => {
    fakeData().answer = () => {
      throw new Error("down");
    };
    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("account.not_found");
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("returns 404 when the original decision does not exist", async () => {
    mockQueryAudits.mockResolvedValue([]);

    const res = await POST(
      postReq({ originalDecisionId: "traj-x", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(404);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("returns 403 on cross-user appeal (ownership mismatch)", async () => {
    mockQueryAudits.mockResolvedValue([makeAuditRecord({ userId: "someone-else" })]);

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(403);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("derives previousAccountStatus from the Sentinel audit entry (F1)", async () => {
    mockQueryAudits.mockResolvedValue([makeAuditRecord({ userId: "u-app" })]);
    (getAuditLogForUser as jest.Mock).mockResolvedValue([
      {
        action: "admin_action",
        details: {
          type: "sentinel_decision",
          trajectoryId: "traj-1",
          previousStatus: "warned",
        },
      },
    ]);
    (submitAppeal as jest.Mock).mockResolvedValue({ success: true, item: { id: "a1" } });

    await POST(postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON }));

    expect(submitAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ previousAccountStatus: "warned" }),
      expect.any(String)
    );
  });

  it("matches Sentinel's status change by the Guardian decision id it records", async () => {
    mockQueryAudits.mockResolvedValue([makeAuditRecord({ userId: "u-app" })]);
    (getAuditLogForUser as jest.Mock).mockResolvedValue([
      {
        action: "admin_action",
        details: {
          type: "sentinel_status_change",
          trajectoryId: "sentinel-run-9",
          guardianDecisionId: "traj-1",
          previousStatus: "restricted",
        },
      },
    ]);
    (submitAppeal as jest.Mock).mockResolvedValue({ success: true, item: { id: "a1" } });

    await POST(postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON }));

    expect(submitAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ previousAccountStatus: "restricted" }),
      expect.any(String)
    );
  });

  it("maps a service validation failure to 400", async () => {
    mockQueryAudits.mockResolvedValue([makeAuditRecord({ userId: "u-app" })]);
    (submitAppeal as jest.Mock).mockResolvedValue({
      success: false,
      error: "Appeal window has expired (72 hours)",
      errorCode: "moderation.appeal_window_expired",
      errorParams: { hours: 72 },
    });

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(400);
  });

  it("maps an already-pending appeal to 409", async () => {
    mockQueryAudits.mockResolvedValue([makeAuditRecord({ userId: "u-app" })]);
    (submitAppeal as jest.Mock).mockResolvedValue({
      success: false,
      error: "An appeal is already pending for this decision",
      errorCode: "moderation.appeal_pending",
    });

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(409);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/appeals", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authAs("moderator") },
      body: "{bad",
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 500 when the moderation store throws", async () => {
    mockQueryAudits.mockRejectedValue(new Error("db down"));

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PATCH /api/moderation/appeals/[id]
// ═══════════════════════════════════════════════════════════════════════

describe("PATCH /api/moderation/appeals/[id]", () => {
  it("resolves an appeal item", async () => {
    mockGetById.mockResolvedValue({
      id: "a1",
      source: "appeal",
      status: "claimed",
      claimedBy: REVIEWER,
    });
    (resolveItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "a1", status: "resolved" },
    });

    const res = await PATCH(
      patchReq({
        action: "resolve",
        decision: "overturn",
        reviewerNotes: "Appeal granted.",
      }),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    expect(resolveItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "a1",
        reviewerId: REVIEWER,
        decision: "overturn",
      })
    );
  });

  it("claims an appeal item", async () => {
    mockGetById.mockResolvedValue({ id: "a1", source: "appeal", status: "pending" });
    (claimItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "a1", status: "claimed" },
    });

    const res = await PATCH(patchReq({ action: "claim" }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(claimItem).toHaveBeenCalledWith("a1", REVIEWER);
  });

  it("unclaims an appeal item", async () => {
    mockGetById.mockResolvedValue({
      id: "a1",
      source: "appeal",
      status: "claimed",
      claimedBy: REVIEWER,
    });
    (unclaimItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "a1", status: "pending" },
    });

    const res = await PATCH(patchReq({ action: "unclaim" }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(unclaimItem).toHaveBeenCalledWith("a1", REVIEWER);
  });

  it("returns 404 when the item is not an appeal", async () => {
    mockGetById.mockResolvedValue({ id: "r1", source: "ban_review" });

    const res = await PATCH(patchReq({ action: "claim" }), ctx("r1"));

    expect(res.status).toBe(404);
    expect(claimItem).not.toHaveBeenCalled();
  });

  it("returns 404 when the item does not exist", async () => {
    mockGetById.mockResolvedValue(undefined);

    const res = await PATCH(patchReq({ action: "claim" }), ctx("nope"));

    expect(res.status).toBe(404);
  });

  it.each(["anonymous", "free", "safety_approver", "suspended_super_admin"] as const)(
    "refuses %s before reading the item",
    async (caller) => {
      const res = await PATCH(patchReq({ action: "claim" }, caller), ctx("a1"));
      expect([401, 403]).toContain(res.status);
      expect(mockGetById).not.toHaveBeenCalled();
    }
  );

  it("returns 400 when resolve is missing decision/notes", async () => {
    mockGetById.mockResolvedValue({ id: "a1", source: "appeal" });

    const res = await PATCH(
      patchReq({ action: "resolve", reviewerNotes: "x" }),
      ctx("a1")
    );

    expect(res.status).toBe(400);
    expect(resolveItem).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown action", async () => {
    mockGetById.mockResolvedValue({ id: "a1", source: "appeal" });

    const res = await PATCH(patchReq({ action: "frobnicate" }), ctx("a1"));

    expect(res.status).toBe(400);
  });

  it("maps a lifecycle conflict to 409", async () => {
    mockGetById.mockResolvedValue({ id: "a1", source: "appeal" });
    (claimItem as jest.Mock).mockResolvedValue({
      success: false,
      error: "Item is claimed, not pending",
      errorCode: "moderation.item_state_conflict",
      errorParams: { status: "claimed" },
    });

    const res = await PATCH(patchReq({ action: "claim" }), ctx("a1"));

    expect(res.status).toBe(409);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/appeals/a1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authAs("moderator") },
      body: "{bad",
    });

    const res = await PATCH(req, ctx("a1"));

    expect(res.status).toBe(400);
  });

  it("returns 500 when the store throws", async () => {
    mockGetById.mockRejectedValue(new Error("boom"));

    const res = await PATCH(patchReq({ action: "claim" }), ctx("a1"));

    expect(res.status).toBe(500);
  });
});
