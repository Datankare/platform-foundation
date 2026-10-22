/**
 * __tests__/moderation-reap-route.test.ts — ADR-041 reaper route (option A).
 *
 * Gated on "can_moderate" by the real guard (helpers/test-identities.ts); returns the sweep
 * summary; refuses every role without it; 500 on failure. The pure sweep is covered by the conformance
 * kit (escalation-sla.test.ts) — here we pin the route contract.
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
jest.mock("@/platform/moderation/review-service", () => ({
  reapOverdueEscalations: jest.fn(),
}));

import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { reapOverdueEscalations } from "@/platform/moderation/review-service";
import { POST } from "@/app/api/admin/moderation/reap-escalations/route";

const mockReap = reapOverdueEscalations as jest.Mock;

function req(caller: CallerName = "moderator"): NextRequest {
  return new NextRequest("http://localhost/api/admin/moderation/reap-escalations", {
    method: "POST",
    headers: authAs(caller),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/admin/moderation/reap-escalations", () => {
  it("returns the sweep summary when authorized", async () => {
    mockReap.mockResolvedValue({
      scanned: 3,
      blocked: 3,
      escalatedHigher: 0,
      slaHours: 24,
      cutoff: "2026-01-01T00:00:00.000Z",
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      scanned: 3,
      blocked: 3,
      escalatedHigher: 0,
      slaHours: 24,
    });
    expect(mockReap).toHaveBeenCalledTimes(1);
  });

  it.each(["anonymous", "free", "safety_approver", "suspended_super_admin"] as const)(
    "refuses %s and never runs the sweep",
    async (caller) => {
      const res = await POST(req(caller));
      expect([401, 403]).toContain(res.status);
      expect(mockReap).not.toHaveBeenCalled();
    }
  );

  it("returns 500 when the sweep throws", async () => {
    mockReap.mockRejectedValue(new Error("store down"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("internal.error");
    expect(body.params.requestId).toBe("req-test");
  });
});
