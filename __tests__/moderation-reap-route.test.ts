/**
 * __tests__/moderation-reap-route.test.ts — ADR-041 reaper route (option A).
 *
 * Gated on "can_moderate"; returns the sweep summary; passes the guard's denial
 * through untouched; 500 on failure. The pure sweep is covered by the conformance
 * kit (escalation-sla.test.ts) — here we pin the route contract.
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));
jest.mock("@/platform/auth/admin-guard", () => ({
  adminGuard: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/platform/moderation/review-service", () => ({
  reapOverdueEscalations: jest.fn(),
}));

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { reapOverdueEscalations } from "@/platform/moderation/review-service";
import { POST } from "@/app/api/admin/moderation/reap-escalations/route";

const mockGuard = adminGuard as jest.Mock;
const mockReap = reapOverdueEscalations as jest.Mock;

function req(): NextRequest {
  return new NextRequest("http://localhost/api/admin/moderation/reap-escalations", {
    method: "POST",
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue(null);
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

  it("passes the guard's denial through and never runs the sweep", async () => {
    mockGuard.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 })
    );
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(mockReap).not.toHaveBeenCalled();
  });

  it("returns 500 when the sweep throws", async () => {
    mockReap.mockRejectedValue(new Error("store down"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/reaper failed/i);
  });
});
