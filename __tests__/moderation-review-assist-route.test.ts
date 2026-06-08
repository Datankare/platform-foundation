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

jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
}));

const mockGetById = jest.fn();
jest.mock("@/platform/moderation/review-store", () => ({
  getReviewQueueStore: () => ({ getById: mockGetById }),
}));

const mockGenerate = jest.fn();
jest.mock("@/platform/moderation/review-assist", () => ({
  generateReviewRecommendation: (...args: unknown[]) => mockGenerate(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { POST } from "@/app/api/moderation/review/[id]/assist/route";

function assistReq(): NextRequest {
  return new NextRequest("http://localhost/api/moderation/review/review-1/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  (adminGuard as jest.Mock).mockResolvedValue(null);
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

  it("returns the guard response when RBAC denies", async () => {
    (adminGuard as jest.Mock).mockResolvedValueOnce(
      NextResponse.json({ error: "denied" }, { status: 403 })
    );

    const res = await POST(assistReq(), ctx("review-1"));

    expect(res.status).toBe(403);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it("returns 500 when the store throws", async () => {
    mockGetById.mockRejectedValue(new Error("boom"));

    const res = await POST(assistReq(), ctx("review-1"));

    expect(res.status).toBe(500);
  });
});
