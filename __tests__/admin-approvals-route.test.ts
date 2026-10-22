/**
 * __tests__/admin-approvals-route.test.ts — ADR-040 040a GET /api/admin/approvals.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
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
jest.mock("@/platform/admin/pending-approvals", () => ({
  listPendingApprovals: jest.fn(),
}));

import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { GET } from "@/app/api/admin/approvals/route";

const mockList = listPendingApprovals as jest.Mock;

function req(caller: CallerName = "safety_approver"): NextRequest {
  return new NextRequest("http://localhost/api/admin/approvals", {
    headers: authAs(caller),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
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

  it.each(["anonymous", "guest", "free", "suspended_super_admin"] as const)(
    "refuses %s and never lists",
    async (caller) => {
      const res = await GET(req(caller));
      expect([401, 403]).toContain(res.status);
      expect(mockList).not.toHaveBeenCalled();
    }
  );

  it("returns 500 when listing fails", async () => {
    mockList.mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("internal.error");
  });
});
