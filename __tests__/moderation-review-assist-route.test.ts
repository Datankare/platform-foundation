/**
 * __tests__/moderation-review-assist-route.test.ts
 *
 * Route-integrity tests for POST /api/moderation/review/[id]/assist. The
 * reviewer-assist service is mocked here; the service itself is covered in
 * moderation-review-assist.test.ts.
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

const mockGetById = jest.fn();
jest.mock("@/platform/moderation/review-store", () => ({
  getReviewQueueStore: () => ({ getById: mockGetById }),
}));

const mockGenerate = jest.fn();
jest.mock("@/platform/moderation/review-assist", () => ({
  generateReviewRecommendation: (...args: unknown[]) => mockGenerate(...args),
}));

import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { POST } from "@/app/api/moderation/review/[id]/assist/route";

function assistReq(caller: CallerName = "moderator"): NextRequest {
  return new NextRequest("http://localhost/api/moderation/review/review-1/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authAs(caller) },
  });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetById.mockResolvedValue({ id: "review-1", source: "escalation" });
});

describe("POST /api/moderation/review/[id]/assist", () => {
  it("returns the recommendation for an existing item", async () => {
    mockGenerate.mockResolvedValue({ recommendation: "overturn", rationale: "Context." });

    const res = await POST(assistReq(), ctx("review-1"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendation.recommendation).toBe("overturn");
  });

  it("passes through a null recommendation (fail-open) as 200", async () => {
    mockGenerate.mockResolvedValue(null);

    const res = await POST(assistReq(), ctx("review-1"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recommendation).toBeNull();
  });

  it("returns 404 when the item does not exist", async () => {
    mockGetById.mockResolvedValue(undefined);

    const res = await POST(assistReq(), ctx("nope"));

    expect(res.status).toBe(404);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it.each(["anonymous", "free", "safety_approver", "suspended_super_admin"] as const)(
    "refuses %s before reading the item (the assist call is paid)",
    async (caller) => {
      const res = await POST(assistReq(caller), ctx("review-1"));
      expect([401, 403]).toContain(res.status);
      expect(mockGetById).not.toHaveBeenCalled();
      expect(mockGenerate).not.toHaveBeenCalled();
    }
  );

  it("returns 500 when the store throws", async () => {
    mockGetById.mockRejectedValue(new Error("boom"));

    const res = await POST(assistReq(), ctx("review-1"));

    expect(res.status).toBe(500);
  });
});

describe("assist: self-review and the daily quota (release review, Sprint 7X)", () => {
  it("refuses a moderator asking for advice on a case about their own account", async () => {
    const { CALLERS } = jest.requireActual("@/__tests__/helpers/test-identities");
    mockGetById.mockResolvedValue({
      id: "review-1",
      source: "appeal",
      targetUserId: CALLERS.moderator.userId,
    });
    const res = await POST(assistReq(), ctx("review-1"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("moderation.self_review");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("counts the paid call against the moderator's quota, and stops at it", async () => {
    const { enforceDailyPaidQuota } = jest.requireMock("@/platform/rate-limit");
    const { NextResponse } = jest.requireActual("next/server");
    (enforceDailyPaidQuota as jest.Mock).mockResolvedValueOnce(
      NextResponse.json({ code: "rate.limited" }, { status: 429 })
    );
    const res = await POST(assistReq(), ctx("review-1"));
    expect(res.status).toBe(429);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
