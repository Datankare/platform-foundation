/**
 * __tests__/admin-approval-decision-route.test.ts — ADR-040 040b conformance kit (L21)
 *
 * POST /api/admin/approvals/[id]: the approver rule enforced server-side, with the real admin
 * guard and real roles (helpers/test-identities.ts). A safety_approver who is not the requester
 * can clear a hold; the requester cannot approve their own change, even as super_admin, whether
 * the hold names them as the agent's principal or as the requester; a plain admin cannot;
 * super_admin break-glass can; an approved config change is applied (audit X-10).
 */
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
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-1",
}));
jest.mock("@/platform/agents/proposal-store", () => ({ getProposalStore: jest.fn() }));
jest.mock("@/platform/agents/gating", () => ({
  approveHeldAction: jest.fn(),
  rejectHeldAction: jest.fn(),
  principalOf: jest.requireActual("@/platform/agents/gating").principalOf,
}));
// The real audit module writes through a fake platform/data (helpers/fake-data.ts).
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/platform/admin/config-approval", () => {
  const approveChange = jest.fn();
  return {
    getApproval: jest.fn(),
    approveChange,
    rejectChange: jest.fn(),
    // The module's contract (unit-tested in config-approval.test.ts): approve, then apply;
    // a change that cannot be applied comes back as a coded failure.
    approveAndApply: jest.fn(
      async (
        id: string,
        by: string,
        note: string,
        apply: (r: unknown) => Promise<{ success: boolean; error?: string }>
      ) => {
        const r = await approveChange(id, by, note);
        if (!r.success || !r.record) return r;
        const a = await apply(r.record);
        return a.success
          ? r
          : {
              success: false,
              error: a.error,
              errorCode: "service.unavailable",
              errorParams: { service: "config" },
            };
      }
    ),
  };
});
jest.mock("@/platform/admin/pending-approvals", () => ({
  requiredPermissionForKey: jest.fn(async () => "config_manage_safety"),
  proposalConfigKey: jest.fn(() => undefined),
}));
jest.mock("@/platform/auth/platform-config", () => ({
  setConfigWithHistory: jest.fn(),
  clearTenantConfig: jest.fn(),
}));
jest.mock("@/platform/admin/config-handlers", () => ({
  runApprovedConfigChange: jest.fn(),
}));

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { approveHeldAction, rejectHeldAction } from "@/platform/agents/gating";
import {
  getApproval,
  approveChange,
  rejectChange,
} from "@/platform/admin/config-approval";
import { setConfigWithHistory } from "@/platform/auth/platform-config";
import { fakeData } from "./helpers/fake-data";
import { runApprovedConfigChange } from "@/platform/admin/config-handlers";
import { POST } from "@/app/api/admin/approvals/[id]/route";

const mockStore = getProposalStore as jest.Mock;
const mockApproveHeld = approveHeldAction as jest.Mock;
const mockRejectHeld = rejectHeldAction as jest.Mock;
const mockGetApproval = getApproval as jest.Mock;
const mockApproveChange = approveChange as jest.Mock;
const mockRejectChange = rejectChange as jest.Mock;
const mockApply = setConfigWithHistory as jest.Mock;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function req(
  body: unknown,
  caller: CallerName = "safety_approver",
  raw?: string
): NextRequest {
  return new NextRequest("http://localhost/api/admin/approvals/p1", {
    method: "POST",
    body: raw ?? JSON.stringify(body),
    headers: { "content-type": "application/json", ...authAs(caller) },
  });
}

/** A runtime hold made by the config agent acting for `principal`. */
function holdFor(principal: string | undefined) {
  mockStore.mockReturnValue({
    getById: jest.fn().mockResolvedValue({
      proposalId: "p1",
      label: "update_config",
      status: "proposed",
      actor: {
        actorType: "agent",
        actorId: "config-manager-x",
        agentRole: "config-manager",
        ...(principal ? { onBehalfOf: principal } : {}),
      },
      payload: {},
    }),
  });
}

const approveRuntime = (caller: CallerName = "safety_approver") =>
  POST(req({ decision: "approve", source: "runtime" }, caller), ctx("p1"));

beforeEach(() => {
  jest.clearAllMocks();
  fakeData().reset();
  holdFor(CALLERS.super_admin.userId);
  mockApproveHeld.mockResolvedValue({ kind: "approved", proposal: {} });
  mockRejectHeld.mockResolvedValue({ status: "rejected" });
  mockApply.mockResolvedValue({ success: true });
  (runApprovedConfigChange as jest.Mock).mockResolvedValue({
    toolId: "update_config",
    success: true,
    data: { applied: true },
    durationMs: 1,
  });
});

describe("an approved held config change is applied on its approval", () => {
  const resume = runApprovedConfigChange as jest.Mock;
  const tool = (data: Record<string, unknown>, success = true, error?: string) =>
    resume.mockResolvedValue({
      toolId: "update_config",
      success,
      data,
      error,
      durationMs: 1,
    });

  it("applies it, and says so", async () => {
    tool({ applied: true });
    const res = await approveRuntime();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "approved", applied: true });
    expect(resume).toHaveBeenCalledWith("p1");
  });

  it("a safety key under two-person approval goes on to wait for that approval", async () => {
    tool({ applied: false, requiresApproval: true, approval: { id: "apr-2" } });
    const res = await approveRuntime();
    expect(await res.json()).toMatchObject({
      applied: false,
      pendingApproval: { id: "apr-2" },
    });
  });

  it.each([
    ["the tool failed", false, {}, "audit down"],
    [
      "the change was refused",
      true,
      { applied: false, error: "governs the platform" },
      undefined,
    ],
  ])(
    "answers 503, naming nothing internal, when %s",
    async (_l, success, data, error) => {
      tool(data, success, error);
      const res = await approveRuntime();
      expect(res.status).toBe(503);
      const json = await res.json();
      // True (review 10 H2): the approval stands, and approving again retries it.
      expect(json.code).toBe("approvals.run_failed");
      const body = JSON.stringify(json);
      expect(body).not.toContain("audit down");
      expect(body).not.toContain("governs the platform");
    }
  );

  it("a hold no authority owns is not decided here — an agent's step is its owner's (B-10)", async () => {
    mockStore.mockReturnValue({
      getById: jest.fn().mockResolvedValue({
        proposalId: "p1",
        label: "process_content",
        status: "proposed",
        actor: { actorType: "agent", actorId: "agent-1", onBehalfOf: "someone" },
        payload: {},
      }),
    });
    for (const caller of ["safety_approver", "super_admin"] as const) {
      const res = await approveRuntime(caller);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("approvals.hold_not_found");
    }
    expect(mockApproveHeld).not.toHaveBeenCalled();
  });

  it("runs an approved hold whose run failed again on a new approval — without re-approving", async () => {
    mockStore.mockReturnValue({
      getById: jest.fn().mockResolvedValue({
        proposalId: "p1",
        label: "update_config",
        status: "approved",
        actor: {
          actorType: "agent",
          actorId: "config-manager-x",
          onBehalfOf: CALLERS.super_admin.userId,
        },
        payload: {},
      }),
    });
    tool({ applied: true });
    const res = await approveRuntime();
    expect(res.status).toBe(200);
    expect(mockApproveHeld).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith("p1");
  });
});

describe("POST /api/admin/approvals/[id] — ADR-040 040b", () => {
  it("lets an independent safety_approver approve, recorded under their users.id", async () => {
    const res = await approveRuntime();
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("approved");
    expect(mockApproveHeld).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "p1",
        decidedBy: CALLERS.safety_approver.userId,
      })
    );
  });

  it("blocks the agent's principal approving their own change, even a super_admin (X-10)", async () => {
    const res = await approveRuntime("super_admin");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("approvals.self_approval");
    expect(mockApproveHeld).not.toHaveBeenCalled();
  });

  it("blocks a hold recorded under the requester's identity-provider subject", async () => {
    holdFor(CALLERS.safety_approver.sub);
    expect((await approveRuntime()).status).toBe(409);
  });

  it("lets the requester reject their own hold", async () => {
    holdFor(CALLERS.safety_approver.userId);
    const res = await POST(req({ decision: "reject", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(200);
    expect(mockRejectHeld).toHaveBeenCalled();
  });

  it("refuses a plain admin, who lacks config_manage_safety", async () => {
    const res = await approveRuntime("admin");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("approvals.permission_required");
    expect(mockApproveHeld).not.toHaveBeenCalled();
  });

  it("allows a super_admin break-glass approval of someone else's hold", async () => {
    holdFor(CALLERS.admin.userId);
    expect((await approveRuntime("super_admin")).status).toBe(200);
  });

  it.each(["anonymous", "free", "suspended_super_admin"] as const)(
    "refuses %s before reading the hold",
    async (caller) => {
      const res = await approveRuntime(caller);
      expect([401, 403]).toContain(res.status);
      expect(mockApproveHeld).not.toHaveBeenCalled();
    }
  );

  it("refuses a moderator (no config_manage_safety)", async () => {
    expect((await approveRuntime("moderator")).status).toBe(403);
  });

  it.each(["already-decided", "stale"])(
    "answers 409 when the approval did not commit (%s) — never a 200 for a decision not made",
    async (kind) => {
      mockApproveHeld.mockResolvedValue({ kind, proposal: undefined });
      const res = await approveRuntime();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("approvals.decision_conflict");
    }
  );

  it("refuses the attested owner approving their agent's hold even under a disagreeing claim", async () => {
    mockStore.mockReturnValue({
      getById: jest.fn().mockResolvedValue({
        proposalId: "p1",
        label: "update_config",
        status: "proposed",
        actor: {
          actorType: "agent",
          actorId: "config-manager-x",
          agentRole: "config-manager",
          onBehalfOf: "someone-else",
          delegation: {
            onBehalfOf: CALLERS.safety_approver.userId,
            scope: [],
            method: "oauth2.1-pkce",
          },
        },
        payload: {},
      }),
    });
    const res = await approveRuntime();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("approvals.self_approval");
    expect(mockApproveHeld).not.toHaveBeenCalled();
  });

  it("answers 409 when a reject lost the race to an approval (register PR-7)", async () => {
    holdFor(CALLERS.safety_approver.userId);
    mockRejectHeld.mockResolvedValue(undefined);
    const res = await POST(req({ decision: "reject", source: "runtime" }), ctx("p1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("approvals.decision_conflict");
  });

  describe("config-approval holds", () => {
    beforeEach(() => {
      mockGetApproval.mockResolvedValue({
        id: "a1",
        requestedBy: CALLERS.admin.userId,
        configKey: "moderation.strike_ban_threshold",
      });
      mockApproveChange.mockResolvedValue({
        success: true,
        record: {
          configKey: "moderation.strike_ban_threshold",
          currentValue: 3,
          proposedValue: 4,
          changeComment: "tighten",
          scope: "platform",
        },
      });
    });

    const decide = (decision: string, caller: CallerName = "safety_approver") =>
      POST(req({ decision, source: "config-approval" }, caller), ctx("a1"));

    it("approves as the verified approver and applies the approved value", async () => {
      const res = await decide("approve");
      expect(res.status).toBe(200);
      expect(mockApproveChange).toHaveBeenCalledWith(
        "a1",
        CALLERS.safety_approver.userId,
        ""
      );
      expect(mockApply).toHaveBeenCalledWith(
        "moderation.strike_ban_threshold",
        4,
        CALLERS.safety_approver.userId,
        "Approved: tighten",
        "config_agent",
        undefined,
        // Outside a shared deployment the recorded scope is applied as the approver.
        { scope: "platform", operator: false },
        // Only onto the value it was requested against (review 12 H2).
        { expectPrevious: { value: 3 } }
      );
    });

    it("refuses the requester approving their own change", async () => {
      mockGetApproval.mockResolvedValue({
        id: "a1",
        requestedBy: CALLERS.safety_approver.userId,
        configKey: "k",
      });
      expect((await decide("approve")).status).toBe(409);
      expect(mockApproveChange).not.toHaveBeenCalled();
    });

    it("answers 503 (the approval is reopened) when an approved change cannot be applied", async () => {
      mockApply.mockResolvedValue({ success: false, error: "db down" });
      const res = await decide("approve");
      expect(res.status).toBe(503);
      expect(fakeData().audit.map((r) => r.details.outcome)).toEqual([
        "attempted",
        "failed",
      ]);
    });

    it("does not apply anything on a rejection", async () => {
      mockRejectChange.mockResolvedValue({ success: true });
      expect((await decide("reject")).status).toBe(200);
      expect(mockApply).not.toHaveBeenCalled();
    });

    it("passes a coded refusal from the approval service through", async () => {
      mockApproveChange.mockResolvedValue({
        success: false,
        errorCode: "approvals.expired",
        error: "expired",
      });
      expect((await decide("approve")).status).toBe(409);
      expect(mockApply).not.toHaveBeenCalled();
    });
  });

  it("404s when the hold is not found", async () => {
    mockStore.mockReturnValue({ getById: jest.fn().mockResolvedValue(undefined) });
    expect((await approveRuntime()).status).toBe(404);
  });

  it.each([
    [{ decision: "maybe", source: "runtime" }],
    [{ decision: "approve", source: "bogus" }],
    [{ decision: ["approve"], source: "runtime" }],
  ])("400s on %p", async (body) => {
    expect((await POST(req(body), ctx("p1"))).status).toBe(400);
  });

  it("400s on a malformed body", async () => {
    expect((await POST(req(undefined, "safety_approver", "{x"), ctx("p1"))).status).toBe(
      400
    );
  });
});

describe("every decision is recorded first (release review, Sprint 7X)", () => {
  it("records the decider, the requester and the decision before it takes effect", async () => {
    await approveRuntime();
    expect(fakeData().audit[0]).toMatchObject({
      actor_id: CALLERS.safety_approver.userId,
      details: expect.objectContaining({
        type: "approval_decision",
        decision: "approve",
        requester: CALLERS.super_admin.userId,
        outcome: "attempted",
      }),
    });
  });

  it("decides nothing when the audit log is unavailable", async () => {
    fakeData().failAudit = true;
    const res = await approveRuntime();
    expect(res.status).toBe(503);
    expect(mockApproveHeld).not.toHaveBeenCalled();
  });
});
