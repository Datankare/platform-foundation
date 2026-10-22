/**
 * __tests__/moderation-review-routes.test.ts
 *
 * Route-integrity tests for the human review API:
 *   GET    /api/moderation/review        — list / filter / stats
 *   POST   /api/moderation/review        — manual submit
 *   PATCH  /api/moderation/review/[id]   — claim / unclaim / resolve
 *
 * The review service is mocked; the admin guard is real, with callers holding their real
 * roles' permissions (helpers/test-identities.ts). These tests verify the route layer: RBAC
 * gating ("can_moderate") for every role, request validation, query parsing, the reviewer id
 * taken from the verified moderator, status-code mapping, and error paths.
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

jest.mock("@/platform/moderation/review-service", () => ({
  getQueue: jest.fn(),
  getQueueStats: jest.fn(),
  submitForReview: jest.fn(),
  claimItem: jest.fn(),
  unclaimItem: jest.fn(),
  resolveItem: jest.fn(),
}));

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
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

const REVIEWER = CALLERS.moderator.userId;
/** A moderation result with the fields the review pipeline reads. */
const mr = (action: string) => ({
  action,
  reasoning: "Held for review.",
  trajectoryId: "traj-manual",
  contextFactors: [],
  blocklistMatches: [],
});
const REVIEWER_ID = "00000000-0000-4000-8000-0000000000e9";
const TARGET = "00000000-0000-4000-8000-0000000000c1";

function jsonRequest(
  method: string,
  body?: unknown,
  url = "http://localhost/api/moderation/review",
  caller: CallerName = "moderator"
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...authAs(caller) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function getRequest(
  query: Record<string, string> = {},
  caller: CallerName = "moderator"
): NextRequest {
  const url = new URL("http://localhost/api/moderation/review");
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, { method: "GET", headers: authAs(caller) });
}

function patchCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
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
    expect(getQueue).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it("parses all filters including numeric limit", async () => {
    (getQueue as jest.Mock).mockResolvedValue([]);

    await GET(
      getRequest({
        source: "escalation",
        priority: "high",
        targetUserId: TARGET,
        claimedBy: REVIEWER_ID,
        since: "2026-01-01",
        before: "2026-12-31",
        limit: "5",
      })
    );

    expect(getQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "escalation",
        priority: "high",
        targetUserId: TARGET,
        claimedBy: REVIEWER_ID,
        since: "2026-01-01",
        before: "2026-12-31",
        limit: 5,
      })
    );
  });

  it("caps the page size", async () => {
    (getQueue as jest.Mock).mockResolvedValue([]);
    await GET(getRequest({ limit: "1000000000" }));
    expect(getQueue).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it.each(["targetUserId", "claimedBy"])(
    "refuses a %s that is not a user id, without querying",
    async (field) => {
      const res = await GET(getRequest({ [field]: "x,id.neq.0" }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("request.invalid_value");
      expect(getQueue).not.toHaveBeenCalled();
    }
  );

  it("returns stats with ?view=stats", async () => {
    (getQueueStats as jest.Mock).mockResolvedValue({ pendingCount: 3 });

    const res = await GET(getRequest({ view: "stats" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.stats.pendingCount).toBe(3);
    expect(getQueue).not.toHaveBeenCalled();
  });

  it.each([
    "anonymous",
    "guest",
    "free",
    "safety_approver",
    "suspended_super_admin",
  ] as const)("refuses %s (no can_moderate, or not in good standing)", async (caller) => {
    const res = await GET(getRequest({}, caller));
    expect([401, 403]).toContain(res.status);
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
        source: "escalation",
        moderationResult: mr("escalate"),
        targetUserId: TARGET,
      })
    );
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.item.id).toBe("review-9");
    expect(submitForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "escalation",
        targetUserId: TARGET,
        requestId: "test-req-id",
      })
    );
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await POST(jsonRequest("POST", { source: "ban_review" }));

    expect(res.status).toBe(400);
    expect(submitForReview).not.toHaveBeenCalled();
  });

  it("refuses a hand-made ban_review, and never passes a previous status through (X-2)", async () => {
    const res = await POST(
      jsonRequest("POST", {
        source: "ban_review",
        moderationResult: mr("block"),
        targetUserId: TARGET,
        previousAccountStatus: "banned",
      })
    );
    expect(res.status).toBe(400);
    expect(submitForReview).not.toHaveBeenCalled();
  });

  it("drops a previousAccountStatus sent with an escalation", async () => {
    (submitForReview as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "r" },
    });
    await POST(
      jsonRequest("POST", {
        source: "escalation",
        moderationResult: mr("escalate"),
        targetUserId: TARGET,
        previousAccountStatus: "banned",
      })
    );
    expect(
      (submitForReview as jest.Mock).mock.calls[0][0].previousAccountStatus
    ).toBeUndefined();
  });

  it.each(["u1", "x,y", 7])("refuses the target id %p", async (targetUserId) => {
    const res = await POST(
      jsonRequest("POST", { source: "escalation", moderationResult: {}, targetUserId })
    );
    expect(res.status).toBe(400);
    expect(submitForReview).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["an unknown action", { ...mr("block"), action: "nuke" }],
    ["no trajectory id", { ...mr("block"), trajectoryId: 5 }],
  ])("refuses a moderation result that is %s", async (_label, moderationResult) => {
    const res = await POST(
      jsonRequest("POST", {
        source: "escalation",
        moderationResult,
        targetUserId: TARGET,
      })
    );
    expect(res.status).toBe(400);
    expect(submitForReview).not.toHaveBeenCalled();
  });

  it("rejects the appeal source (appeals have their own endpoint)", async () => {
    const res = await POST(
      jsonRequest("POST", {
        source: "appeal",
        moderationResult: mr("block"),
        targetUserId: TARGET,
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
        source: "escalation",
        moderationResult: mr("block"),
        targetUserId: TARGET,
      })
    );

    expect(res.status).toBe(500);
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authAs("moderator") },
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
    expect(claimItem).toHaveBeenCalledWith("review-1", REVIEWER);
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
    expect(unclaimItem).toHaveBeenCalledWith("review-1", REVIEWER);
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
        reviewerId: REVIEWER,
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
      errorCode: "moderation.review_item_not_found",
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
      errorCode: "moderation.item_state_conflict",
      errorParams: { status: "claimed" },
    });

    const res = await PATCH(
      jsonRequest("PATCH", { action: "claim" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("moderation.item_state_conflict");
  });

  it("returns 400 for an unknown action", async () => {
    const res = await PATCH(
      jsonRequest("PATCH", { action: "frobnicate" }),
      patchCtx("review-1")
    );

    expect(res.status).toBe(400);
  });

  it("never takes the reviewer from the body (audit X-8)", async () => {
    (claimItem as jest.Mock).mockResolvedValue({
      success: true,
      item: { id: "review-1" },
    });
    await PATCH(
      jsonRequest("PATCH", { action: "claim", reviewerId: CALLERS.super_admin.userId }),
      patchCtx("review-1")
    );
    expect(claimItem).toHaveBeenCalledWith("review-1", REVIEWER);
  });

  it.each(["anonymous", "free", "safety_approver", "suspended_super_admin"] as const)(
    "refuses %s",
    async (caller) => {
      const res = await PATCH(
        jsonRequest("PATCH", { action: "claim" }, undefined, caller),
        patchCtx("review-1")
      );
      expect([401, 403]).toContain(res.status);
      expect(claimItem).not.toHaveBeenCalled();
    }
  );

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/moderation/review/review-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authAs("moderator") },
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
