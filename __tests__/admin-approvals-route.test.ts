/**
 * __tests__/admin-approvals-route.test.ts — ADR-040 040a GET /api/admin/approvals.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));
jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/platform/admin/pending-approvals", () => ({
  listPendingApprovals: jest.fn(),
}));

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { GET } from "@/app/api/admin/approvals/route";

const mockGuard = adminGuard as jest.Mock;
const mockList = listPendingApprovals as jest.Mock;

function req(): NextRequest {
  return new NextRequest("http://localhost/api/admin/approvals");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue(null);
});

describe("GET /api/admin/approvals", () => {
  it("returns the merged list when authorized", async () => {
    mockList.mockResolvedValue([
      { source: "runtime", id: "p1", label: "config.set", requester: "admin-1" },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].id).toBe("p1");
  });

  it("passes the guard's denial through and never lists", async () => {
    mockGuard.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 })
    );
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns 500 when listing fails", async () => {
    mockList.mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/failed/i);
  });
});
