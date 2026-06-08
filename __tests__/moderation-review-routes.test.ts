/**
 * __tests__/moderation-review-routes.test.ts
 *
 * Route-integrity tests for the human review API:
 *   GET    /api/moderation/review        — list / filter / stats
 *   POST   /api/moderation/review        — manual submit
 *   PATCH  /api/moderation/review/[id]   — claim / unclaim / resolve
 *
 * The review service and auth guards are mocked — these tests verify the route
 * layer: RBAC gating ("can_moderate"), request validation, query parsing,
 * reviewer-id derivation from the token, status-code mapping, and error paths.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-req-id"),
}));

jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/platform/auth/middleware", () => ({
  optionalAuth: jest.fn().mockResolvedValue({ user: { sub: "rev-1" }, accessToken: "t" }),
}));

jest.mock("@/platform/moderation/review-service", () => ({
  getQueue: jest.fn(),
  getQueueStats: jest.fn(),
  submitForReview: jest.fn(),
  claimItem: jest.fn(),
  unclaimItem: jest.fn(),
  resolveItem: jest.fn(),
}));

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { optionalAuth } from "@/platform/auth/middleware";
import {
  getQueue,
  getQueueStats,
  submitForReview,
  claimItem,
  unclaimItem,
  resolveItem,
} from "@/platform/moderation/review-service";
import { GET, POST } from "@/app/api/moderation/review/route";
import { PATCH } from "@/app/api/moderation/review/[id]/route";

// ── Helpers ─────────────────────────────────────────────────────────────

function jsonRequest(
  method: string,
  body?: unknown,
  url = "http://localhost/api/moderation/review"
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function getRequest(query: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/moderation/review");
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, { method: "GET" });
}

function patchCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  (adminGuard as jest.Mock).mockResolvedValue(null);
  (optionalAuth as jest.Mock).mockResolvedValue({
    user: { sub: "rev-1" },
    accessToken: "t",
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /api/moderation/review
// ═══════════════════════════════════════════════════════════════════════

describe("GET /api/moderation/review", () => {
  it("lists queue items and gates on can_moderate", async () => {
    (getQueue as jest.Mock).mockResolvedValue([{ id: "review-1" }]);

    const res = await GET(getRequest({ status: "pending" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.items).toHaveLength(1);
    expect(adminGuard).toHaveBeenCalledWith(expect.anything(), "can_moderate");
    expect(getQueue).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it("parses all filters including numeric limit", async () => {
    (getQueue as jest.Mock).mockResolvedValue([]);

    await GET(
      getRequest({
        source: "escalation",
        priority: "high",
        targetUserId: "u1",
        claimedBy: "rev-1",
        since: "2026-01-01",
        before: "2026-12-31",
        limit: "5",
      })
    );

    expect(getQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "escalation",
        priority: "high",
        targetUserId: "u1",
        claimedBy: "rev-1",
        since: "2026-01-01",
        before: "2026-12-31",
        limit: 5,
      })
    );
  });

  it("returns stats with ?view=stats", async () => {
    (getQueueStats as jest.Mock).mockResolvedValue({ pendingCount: 3 });

    const res = await GET(getRequest({ view: "stats" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.stats.pendingCount).toBe(3);
    expect(getQueue).not.toHaveBeenCalled();
  });

  it("returns the guard response when RBAC denies", async () => {
    (adminGuard as jest.Mock).mockResolvedValueOnce(
      NextResponse.json({ error: "denied" }, { status: 403 })
    );

    const res = await GET(getRequest());

    expect(res.status).toBe(403);
    expect(getQueue).not.toHaveBeenCalled();
  });

  it("returns 500 when the service throws", async () => {
    (getQueue as jest.Mock).mockRejectedValue(new Error("boom"));

    const res = await GET(getRequest());

    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/moderation/review
// ═══════════════════════════════════════════════════════════════════════

describe("POST /api/moderation/review", () => {
  it("submits a valid review item and returns 201", async () => {
    (submitForReview as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "review-9" },
    });

    const res = await POST(
      jsonRequest("POST", {
        source: "ban_review",
        moderationResult: { action: "block" },
        targetUserId: "u1",
      })
    );
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.item.id).toBe("review-9");
    expect(submitForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ban_review",
        targetUserId: "u1",
        requestId: "test-req-id",
      })
    );
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await POST(jsonRequest("POST", { source: "ban_review" }));

    expect(res.status).toBe(400);
    expect(submitForReview).not.toHaveBeenCalled();
  });

  it("rejects the appeal source (appeals have their own endpoint)", async () => {
    const res = await POST(
      jsonRequest("POST", {
        source: "appeal",
        moderationResult: { action: "block" },
        targetUserId: "u1",
      })
    );

    expect(res.status).toBe(400);
    expect(submitForReview).not.toHaveBeenCalled();
  });

  it("returns 500 when the service reports failure", async () => {
    (submitForReview as jest.Mock).mockResolvedValue({
      success: false,
      error: "store down",
    });

    const res = await POST(
      jsonRequest("POST", {
        source: "ban_review",
        moderationResult: { action: "block" },
        targetUserId: "u1",
      })
    );

    expect(res.status).toBe(500);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PATCH /api/moderation/review/[id]
// ═══════════════════════════════════════════════════════════════════════

describe("PATCH /api/moderation/review/[id]", () => {
  it("claims with the reviewer id from the token", async () => {
    (claimItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "review-1", status: "claimed" },
    });

    const res = await PATCH(
      jsonRequest("PATCH", { action: "claim" }),
      patchCtx("review-1")
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(claimItem).toHaveBeenCalledWith("review-1", "rev-1");
    expect(data.item.status).toBe("claimed");
  });

  it("unclaims an item", async () => {
    (unclaimItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "review-1", status: "pending" },
    });

    const res = await PATCH(
      jsonRequest("PATCH", { action: "unclaim" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(200);
    expect(unclaimItem).toHaveBeenCalledWith("review-1", "rev-1");
  });

  it("resolves with decision and notes", async () => {
    (resolveItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "review-1", status: "resolved" },
    });

    const res = await PATCH(
      jsonRequest("PATCH", {
        action: "resolve",
        decision: "uphold",
        reviewerNotes: "Confirmed violation.",
      }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(200);
    expect(resolveItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "review-1",
        reviewerId: "rev-1",
        decision: "uphold",
        reviewerNotes: "Confirmed violation.",
      })
    );
  });

  it("passes modifiedAction through on a modify resolution", async () => {
    (resolveItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "review-1" },
    });

    await PATCH(
      jsonRequest("PATCH", {
        action: "resolve",
        decision: "modify",
        reviewerNotes: "Downgraded to a warning.",
        modifiedAction: "warn",
      }),
      patchCtx("review-1")
    );

    expect(resolveItem).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "modify", modifiedAction: "warn" })
    );
  });

  it("returns 400 when resolve is missing decision/notes", async () => {
    const res = await PATCH(
      jsonRequest("PATCH", { action: "resolve", reviewerNotes: "x" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(400);
    expect(resolveItem).not.toHaveBeenCalled();
  });

  it("maps 'not found' to 404", async () => {
    (claimItem as jest.Mock).mockResolvedValue({
      success: false,
      error: "Review item not found: review-x",
    });

    const res = await PATCH(
      jsonRequest("PATCH", { action: "claim" }),
      patchCtx("review-x")
    );

    expect(res.status).toBe(404);
  });

  it("maps a lifecycle conflict to 409", async () => {
    (claimItem as jest.Mock).mockResolvedValue({
      success: false,
      error: "Item is claimed, not pending",
    });

    const res = await PATCH(
      jsonRequest("PATCH", { action: "claim" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(409);
  });

  it("returns 400 for an unknown action", async () => {
    const res = await PATCH(
      jsonRequest("PATCH", { action: "frobnicate" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(400);
  });

  it("falls back to dev-admin when there is no token", async () => {
    (optionalAuth as jest.Mock).mockResolvedValueOnce({ user: null, accessToken: null });
    (claimItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "review-1" },
    });

    await PATCH(jsonRequest("PATCH", { action: "claim" }), patchCtx("review-1"));

    expect(claimItem).toHaveBeenCalledWith("review-1", "dev-admin");
  });

  it("returns the guard response when RBAC denies", async () => {
    (adminGuard as jest.Mock).mockResolvedValueOnce(
      NextResponse.json({ error: "denied" }, { status: 403 })
    );

    const res = await PATCH(
      jsonRequest("PATCH", { action: "claim" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(403);
    expect(claimItem).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/review/review-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });

    const res = await PATCH(req, patchCtx("review-1"));

    expect(res.status).toBe(400);
  });

  it("returns 500 when the service throws", async () => {
    (claimItem as jest.Mock).mockRejectedValue(new Error("boom"));

    const res = await PATCH(
      jsonRequest("PATCH", { action: "claim" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(500);
  });
});
