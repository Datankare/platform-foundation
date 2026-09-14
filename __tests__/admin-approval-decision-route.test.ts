/**
 * __tests__/admin-approval-decision-route.test.ts — ADR-040 040b conformance kit (L21).
 *
 * POST /api/admin/approvals/[id]: the approver rule enforced server-side. A safety_approver
 * who isn't the requester can clear a hold; the requester cannot self-approve even as a
 * super_admin; a plain admin (no config_manage_safety) cannot; super_admin break-glass can;
 * already-decided is idempotent; config-approval holds dispatch correctly.
 */
jest.mock("@/platform/auth/admin-guard", () => ({ adminGuard: jest.fn() }));
jest.mock("@/platform/auth/middleware", () => ({ optionalAuth: jest.fn() }));
jest.mock("@/platform/auth/permissions", () => ({ hasPermission: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-1",
}));
jest.mock("@/platform/agents/proposal-store", () => ({ getProposalStore: jest.fn() }));
jest.mock("@/platform/agents/gating", () => ({
  approveHeldAction: jest.fn(),
  rejectHeldAction: jest.fn(),
}));
jest.mock("@/platform/admin/config-approval", () => ({
  getApproval: jest.fn(),
  approveChange: jest.fn(),
  rejectChange: jest.fn(),
}));
jest.mock("@/platform/admin/pending-approvals", () => ({
  requiredPermissionForKey: jest.fn(async () => "config_manage_safety"),
  proposalConfigKey: jest.fn(() => undefined),
}));

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { optionalAuth } from "@/platform/auth/middleware";
import { hasPermission } from "@/platform/auth/permissions";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { approveHeldAction, rejectHeldAction } from "@/platform/agents/gating";
import { getApproval, approveChange } from "@/platform/admin/config-approval";
import { POST } from "@/app/api/admin/approvals/[id]/route";

const mockGuard = adminGuard as jest.Mock;
const mockAuth = optionalAuth as jest.Mock;
const mockHasPermission = hasPermission as jest.Mock;
const mockStore = getProposalStore as jest.Mock;
const mockApproveHeld = approveHeldAction as jest.Mock;
const mockRejectHeld = rejectHeldAction as jest.Mock;
const mockGetApproval = getApproval as jest.Mock;
const mockApproveChange = approveChange as jest.Mock;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/approvals/p1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue(null);
  mockAuth.mockResolvedValue({ user: { sub: "approver-1" }, accessToken: "t" });
  mockHasPermission.mockResolvedValue(true);
  mockStore.mockReturnValue({
    getById: jest.fn().mockResolvedValue({
      proposalId: "p1",
      actor: { actorId: "requester-1" },
      payload: {},
    }),
  });
  mockApproveHeld.mockResolvedValue({ kind: "approved", proposal: {} });
});

describe("POST /api/admin/approvals/[id] — ADR-040 040b", () => {
  it("lets an independent safety_approver approve a runtime hold", async () => {
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("approved");
    expect(mockApproveHeld).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "p1", decidedBy: "approver-1" })
    );
  });

  it("blocks self-approval — even for a super_admin", async () => {
    mockAuth.mockResolvedValue({ user: { sub: "requester-1" }, accessToken: "t" });
    // super_admin would pass hasPermission, but requester === decidedBy must still fail
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(409);
    expect(mockApproveHeld).not.toHaveBeenCalled();
  });

  it("refuses a plain admin who lacks config_manage_safety", async () => {
    mockHasPermission.mockResolvedValue(false);
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(403);
    expect(mockApproveHeld).not.toHaveBeenCalled();
  });

  it("allows a super_admin break-glass approval", async () => {
    mockAuth.mockResolvedValue({ user: { sub: "super-1" }, accessToken: "t" });
    mockHasPermission.mockResolvedValue(true);
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(200);
  });

  it("is idempotent on an already-decided hold", async () => {
    mockApproveHeld.mockResolvedValue({ kind: "already-decided", proposal: undefined });
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    const body = await res.json();
    expect(body.outcome).toBe("already-decided");
  });

  it("dispatches a reject to rejectHeldAction", async () => {
    const res = await POST(req({ decision: "reject", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(200);
    expect(mockRejectHeld).toHaveBeenCalled();
  });

  it("dispatches a config-approval hold to approveChange", async () => {
    mockGetApproval.mockResolvedValue({
      id: "a1",
      requestedBy: "requester-2",
      configKey: "moderation.strike_ban_threshold",
    });
    mockApproveChange.mockResolvedValue({ success: true });
    const res = await POST(
      req({ decision: "approve", source: "config-approval" }),
      ctx("a1")
    );
    expect(res.status).toBe(200);
    expect(mockApproveChange).toHaveBeenCalledWith("a1", "approver-1", "");
  });

  it("404s when the hold is not found", async () => {
    mockStore.mockReturnValue({ getById: jest.fn().mockResolvedValue(undefined) });
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(404);
  });

  it("400s on an invalid decision", async () => {
    const res = await POST(req({ decision: "maybe", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(400);
  });

  it("400s on an invalid source", async () => {
    const res = await POST(req({ decision: "approve", source: "bogus" }), ctx("p1"));
    expect(res.status).toBe(400);
  });

  it("401s when there is no acting identity", async () => {
    mockAuth.mockResolvedValue({ user: null, accessToken: null });
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(401);
  });

  it("passes the guard denial through", async () => {
    mockGuard.mockResolvedValue(
      NextResponse.json({ error: "forbidden" }, { status: 403 })
    );
    const res = await POST(req({ decision: "approve", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(403);
  });
});
