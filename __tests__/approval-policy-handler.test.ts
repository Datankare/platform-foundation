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

  // Round 11 (the input-keys audit): default_approver, which the schema requires, was dropped.
  // Round 12 (I-2): applied, it may only be a person — an action no rule matches may be
  // restricted — so another is refused, before anything is stored.
  it("sets a person as the default approver, and records it", async () => {
    const r = await handleSetApprovalPolicy(
      { default_approver: "user", rules: [] },
      ACTOR
    );
    expect(r.success).toBe(true);
    expect(setRules).toHaveBeenCalledWith([], ACTOR, "user");
    expect(fakeData().audit[0].details).toMatchObject({ default_approver: "user" });
  });

  it.each(["agent", "system", "anyone"])(
    "refuses %s as the default approver: nothing stored, nothing recorded",
    async (bad) => {
      const r = await handleSetApprovalPolicy(
        { default_approver: bad, rules: [] },
        ACTOR
      );
      expect(r).toMatchObject({
        code: "request.invalid_value",
        params: { field: "default_approver", allowed: ["user"] },
      });
      expect(setRules).not.toHaveBeenCalled();
      expect(fakeData().audit).toHaveLength(0);
    }
  );

  it("keeps the current default approver when given none", async () => {
    await handleSetApprovalPolicy({ rules: [] }, ACTOR);
    expect(setRules).toHaveBeenCalledWith([], ACTOR, undefined);
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

  it("reports a store failure coded, its text logged, never returned (rebase round 2, 2)", async () => {
    setRules.mockRejectedValue(new Error("version conflict"));
    const r = await handleSetApprovalPolicy(
      { default_approver: "user", rules: [] },
      ACTOR
    );
    expect(r).toMatchObject({
      success: false,
      error: "admin.action_failed",
      code: "admin.action_failed",
    });
    expect(JSON.stringify(r)).not.toContain("version conflict");
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
