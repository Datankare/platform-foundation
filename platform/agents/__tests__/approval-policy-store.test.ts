/**
 * platform/agents/__tests__/approval-policy-store.test.ts — A1 (Sprint 3c)
 *
 * Covers the pure resolver and the in-memory store. The seam's DEFAULT behavior (human for
 * everything) is asserted in gating.test.ts; here we prove rule matching, versioning, and
 * that a loosening rule moves the required approver to "agent".
 */

import {
  DEFAULT_APPROVAL_POLICY,
  InMemoryApprovalPolicyStore,
  getApprovalPolicyStore,
  resolveApprover,
  type ApprovalPolicy,
  type ApprovalRule,
} from "../approval-policy-store";

describe("resolveApprover — pure resolution over a policy", () => {
  it("returns the default when no rule matches", () => {
    const approver = resolveApprover(DEFAULT_APPROVAL_POLICY, "restricted", [
      "restricted",
    ]);
    expect(approver.actorType).toBe("user");
  });

  it("matches a rule by risk bound and moves the approver to agent", () => {
    const policy: ApprovalPolicy = {
      version: 2,
      default: "user",
      rules: [{ maxRisk: "consequential", requiredApprover: "agent" }],
    };
    // ordinary <= consequential → matches
    expect(resolveApprover(policy, "ordinary", []).actorType).toBe("agent");
    // restricted > consequential → no match → default
    expect(resolveApprover(policy, "restricted", []).actorType).toBe("user");
  });

  it("requires all listed effects to be present for an effects-scoped rule", () => {
    const policy: ApprovalPolicy = {
      version: 3,
      default: "user",
      rules: [
        { maxRisk: "restricted", effects: ["externalCall"], requiredApprover: "agent" },
      ],
    };
    expect(resolveApprover(policy, "restricted", ["externalCall"]).actorType).toBe(
      "agent"
    );
    expect(resolveApprover(policy, "restricted", ["stateWrite"]).actorType).toBe("user");
  });

  it("takes the first matching rule in policy order", () => {
    const policy: ApprovalPolicy = {
      version: 4,
      default: "user",
      rules: [
        { maxRisk: "restricted", requiredApprover: "system" },
        { maxRisk: "ordinary", requiredApprover: "agent" },
      ],
    };
    expect(resolveApprover(policy, "ordinary", []).actorType).toBe("system");
  });

  it("returns an AgentIdentity shape, not a bare actorType", () => {
    const approver = resolveApprover(DEFAULT_APPROVAL_POLICY, "ordinary", []);
    expect(approver).toEqual(
      expect.objectContaining({
        actorType: expect.any(String),
        actorId: expect.any(String),
        agentRole: "approver",
      })
    );
  });
});

describe("InMemoryApprovalPolicyStore", () => {
  it("loads the default policy when unset", async () => {
    const store = new InMemoryApprovalPolicyStore();
    const policy = await store.load();
    expect(policy).toEqual(DEFAULT_APPROVAL_POLICY);
  });

  it("setRules bumps the version and preserves the default", async () => {
    const store = new InMemoryApprovalPolicyStore();
    const rules: ApprovalRule[] = [{ maxRisk: "ordinary", requiredApprover: "agent" }];
    const updated = await store.setRules(rules, "admin-1");
    expect(updated.version).toBe(2);
    expect(updated.default).toBe("user");
    expect(updated.rules).toEqual(rules);
    // persisted for the next load
    expect((await store.load()).version).toBe(2);
  });
});

describe("getApprovalPolicyStore — singleton", () => {
  it("returns the same instance across calls", () => {
    const a = getApprovalPolicyStore();
    const b = getApprovalPolicyStore();
    expect(a).toBe(b);
  });

  it("defaults to human approval (behavior-preserving)", async () => {
    const policy = await getApprovalPolicyStore().load();
    expect(resolveApprover(policy, "restricted", ["restricted"]).actorType).toBe("user");
  });
});
