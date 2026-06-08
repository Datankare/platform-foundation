/**
 * __tests__/moderation-appeals-routes.test.ts
 *
 * Route-integrity tests for the appeals API:
 *   POST   /api/moderation/appeals        — user submits an appeal
 *   PATCH  /api/moderation/appeals/[id]   — moderator claims/unclaims/resolves
 *
 * Services, stores, and auth are mocked. These verify the security-critical
 * route logic: token-derived identity, server-side decision fetch + ownership
 * check (no cross-user appeals), F1 previousStatus derivation, appeal-scoping,
 * RBAC gating, status mapping, and error paths.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-req-id"),
}));

jest.mock("@/platform/auth/middleware", () => ({
  requireAuth: jest.fn(),
  optionalAuth: jest.fn(),
}));

jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
}));

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

const mockSingle = jest.fn();
const mockSupabase = {
  from: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    single: mockSingle,
  })),
};

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(() => mockSupabase),
}));

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, optionalAuth } from "@/platform/auth/middleware";
import { adminGuard } from "@/platform/auth/admin-guard";
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
import { PATCH } from "@/app/api/moderation/appeals/[id]/route";

// ── Helpers ─────────────────────────────────────────────────────────────

const mockQueryAudits = jest.fn();
const mockGetById = jest.fn();

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/moderation/appeals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/moderation/appeals/a1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
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
  (requireAuth as jest.Mock).mockResolvedValue({
    user: { sub: "cog-1" },
    accessToken: "t",
  });
  (adminGuard as jest.Mock).mockResolvedValue(null);
  (optionalAuth as jest.Mock).mockResolvedValue({
    user: { sub: "rev-1" },
    accessToken: "t",
  });
  (getModerationStore as jest.Mock).mockReturnValue({ queryAudits: mockQueryAudits });
  (getReviewQueueStore as jest.Mock).mockReturnValue({ getById: mockGetById });
  (getAuditLogForUser as jest.Mock).mockResolvedValue([]);
  mockSingle.mockResolvedValue({ data: { id: "u-app" }, error: null });
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

  it("returns the auth error when unauthenticated", async () => {
    (requireAuth as jest.Mock).mockResolvedValue({
      error: NextResponse.json({ error: "auth" }, { status: 401 }),
    });

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 when fields are missing", async () => {
    const res = await POST(postReq({ originalDecisionId: "traj-1" }));

    expect(res.status).toBe(400);
    expect(submitAppeal).not.toHaveBeenCalled();
  });

  it("returns 403 when the user account cannot be resolved", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: "not found" } });

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(403);
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

  it("maps a service validation failure to 400", async () => {
    mockQueryAudits.mockResolvedValue([makeAuditRecord({ userId: "u-app" })]);
    (submitAppeal as jest.Mock).mockResolvedValue({
      success: false,
      error: "Appeal window has expired (72 hours)",
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
    });

    const res = await POST(
      postReq({ originalDecisionId: "traj-1", appealReason: GOOD_REASON })
    );

    expect(res.status).toBe(409);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/appeals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      claimedBy: "rev-1",
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
      expect.objectContaining({ itemId: "a1", reviewerId: "rev-1", decision: "overturn" })
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
    expect(claimItem).toHaveBeenCalledWith("a1", "rev-1");
  });

  it("unclaims an appeal item", async () => {
    mockGetById.mockResolvedValue({
      id: "a1",
      source: "appeal",
      status: "claimed",
      claimedBy: "rev-1",
    });
    (unclaimItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "a1", status: "pending" },
    });

    const res = await PATCH(patchReq({ action: "unclaim" }), ctx("a1"));

    expect(res.status).toBe(200);
    expect(unclaimItem).toHaveBeenCalledWith("a1", "rev-1");
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

  it("returns the guard response when RBAC denies", async () => {
    (adminGuard as jest.Mock).mockResolvedValueOnce(
      NextResponse.json({ error: "denied" }, { status: 403 })
    );

    const res = await PATCH(patchReq({ action: "claim" }), ctx("a1"));

    expect(res.status).toBe(403);
    expect(mockGetById).not.toHaveBeenCalled();
  });

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
    });

    const res = await PATCH(patchReq({ action: "claim" }), ctx("a1"));

    expect(res.status).toBe(409);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/appeals/a1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
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
