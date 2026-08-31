/**
 * __tests__/approval-policy-handler.test.ts — U1 approval-policy handler (Sprint 3c).
 */

import { handleSetApprovalPolicy } from "@/app/api/admin/ai/handlers/approval";

const setRules = jest.fn();
jest.mock("@/platform/agents", () => ({
  getApprovalPolicyStore: () => ({ setRules }),
}));
const writeAuditLog = jest.fn();
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: (...a: unknown[]) => writeAuditLog(...a),
}));

const ACTOR = "admin-1";

beforeEach(() => {
  setRules.mockReset();
  writeAuditLog.mockReset();
  setRules.mockResolvedValue({ version: 2, default: "user", rules: [] });
  writeAuditLog.mockResolvedValue(undefined);
});

describe("handleSetApprovalPolicy", () => {
  it("maps tool input to ApprovalRule[] and mints a version", async () => {
    const r = await handleSetApprovalPolicy(
      {
        default_approver: "user",
        rules: [
          { max_risk: "consequential", required_approver: "user" },
          { max_risk: "ordinary", effects: ["network"], required_approver: "agent" },
        ],
      },
      ACTOR
    );
    expect(r.success).toBe(true);
    const passed = setRules.mock.calls[0][0];
    expect(passed).toEqual([
      { maxRisk: "consequential", requiredApprover: "user" },
      { maxRisk: "ordinary", effects: ["network"], requiredApprover: "agent" },
    ]);
    expect(setRules.mock.calls[0][1]).toBe(ACTOR);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("omits effects when empty", async () => {
    await handleSetApprovalPolicy(
      {
        default_approver: "user",
        rules: [{ max_risk: "ordinary", effects: [], required_approver: "user" }],
      },
      ACTOR
    );
    expect(setRules.mock.calls[0][0][0]).toEqual({
      maxRisk: "ordinary",
      requiredApprover: "user",
    });
  });

  it("handles an empty rule list", async () => {
    const r = await handleSetApprovalPolicy(
      { default_approver: "user", rules: [] },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(setRules.mock.calls[0][0]).toEqual([]);
  });

  it("returns the store error on failure", async () => {
    setRules.mockRejectedValue(new Error("version conflict"));
    const r = await handleSetApprovalPolicy(
      { default_approver: "user", rules: [] },
      ACTOR
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("version conflict");
  });
});
