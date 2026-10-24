/**
 * __tests__/approval-policy-handler.test.ts — U1 approval-policy handler (Sprint 3c).
 */

import { handleSetApprovalPolicy } from "@/app/api/admin/ai/handlers/approval";

import { fakeData } from "./helpers/fake-data";

const setRules = jest.fn();
jest.mock("@/platform/agents", () => ({
  ...jest.requireActual("@/platform/agents"),
  getApprovalPolicyStore: () => ({ setRules }),
}));
// The real audit module writes through a fake platform/data (helpers/fake-data.ts).
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

const ACTOR = "00000000-0000-4000-8000-00000000a001";

beforeEach(() => {
  setRules.mockReset();
  setRules.mockResolvedValue({ version: 2, default: "user", rules: [] });
  fakeData().reset();
});

describe("handleSetApprovalPolicy", () => {
  it("maps tool input to ApprovalRule[] and mints a version", async () => {
    const r = await handleSetApprovalPolicy(
      {
        default_approver: "user",
        rules: [
          { max_risk: "consequential", required_approver: "user" },
          { max_risk: "ordinary", effects: ["externalCall"], required_approver: "agent" },
        ],
      },
      ACTOR
    );
    expect(r.success).toBe(true);
    const passed = setRules.mock.calls[0][0];
    expect(passed).toEqual([
      { maxRisk: "consequential", requiredApprover: "user" },
      { maxRisk: "ordinary", effects: ["externalCall"], requiredApprover: "agent" },
    ]);
    expect(setRules.mock.calls[0][1]).toBe(ACTOR);
    expect(fakeData().audit).toHaveLength(1);
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

describe("handleSetApprovalPolicy — refused policies", () => {
  it.each([
    [
      "an agent approving restricted actions",
      { max_risk: "restricted", required_approver: "agent" },
    ],
    [
      "a system approver for the restricted effect",
      {
        max_risk: "ordinary",
        effects: ["restricted"],
        required_approver: "system",
      },
    ],
    ["an unknown risk level", { max_risk: "low", required_approver: "user" }],
    [
      "an unknown effect",
      { max_risk: "ordinary", effects: ["teleport"], required_approver: "user" },
    ],
    ["an unknown approver", { max_risk: "ordinary", required_approver: "anyone" }],
  ])("refuses %s, storing and recording nothing", async (_label, rule) => {
    const r = await handleSetApprovalPolicy({ rules: [rule] }, ACTOR);
    expect(r).toMatchObject({ success: false, code: "request.invalid_value" });
    expect(setRules).not.toHaveBeenCalled();
    expect(fakeData().audit).toHaveLength(0);
  });

  it("does not change the policy when the audit log is unavailable", async () => {
    fakeData().failAudit = true;
    const r = await handleSetApprovalPolicy(
      { rules: [{ max_risk: "ordinary", required_approver: "user" }] },
      ACTOR
    );
    expect(r).toMatchObject({ success: false, code: "service.unavailable" });
    expect(setRules).not.toHaveBeenCalled();
  });
});
