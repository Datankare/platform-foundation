/**
 * platform/agents/__tests__/approval-policy-store.test.ts — A1 (Sprint 3c)
 *
 * Covers the pure resolver and the in-memory store. The seam's DEFAULT behavior (human for
 * everything) is asserted in gating.test.ts; here we prove rule matching, versioning, and
 * that a loosening rule moves the required approver to "agent".
 */

import { logger } from "@/lib/logger";
import { runWithTenant } from "@/platform/tenancy/context";
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

  // On a consequential action: a rule the stores would take (round 12, I-2 — this used a
  // restricted one, which no store takes and the resolver now never lets decide).
  it("requires all listed effects to be present for an effects-scoped rule", () => {
    const policy: ApprovalPolicy = {
      version: 3,
      default: "user",
      rules: [
        {
          maxRisk: "consequential",
          effects: ["externalCall"],
          requiredApprover: "agent",
        },
      ],
    };
    expect(resolveApprover(policy, "consequential", ["externalCall"]).actorType).toBe(
      "agent"
    );
    expect(resolveApprover(policy, "consequential", ["stateWrite"]).actorType).toBe(
      "user"
    );
  });

  // Round 12, I-2 (a): whatever a policy says — a default or a rule no store would take — a
  // restricted action (by its risk or its effects) is a person's to approve.
  it.each([
    ["a non-person default", { default: "agent", rules: [] }],
    ["a system default", { default: "system", rules: [] }],
    [
      "a rule naming an agent for it",
      { default: "user", rules: [{ maxRisk: "restricted", requiredApprover: "agent" }] },
    ],
  ] as const)("a restricted action is always a person's, despite %s", (_name, p) => {
    const policy = { version: 9, ...p } as unknown as ApprovalPolicy;
    expect(resolveApprover(policy, "restricted", []).actorType).toBe("user");
    expect(resolveApprover(policy, "ordinary", ["restricted"]).actorType).toBe("user");
    expect(
      resolveApprover(policy, "consequential", ["stateWrite", "restricted"]).actorType
    ).toBe("user");
  });

  it("a hand-set non-person default is read as a person's by the store (round 12, I-2)", async () => {
    // A spy on the logger the store holds (it may be loaded before this suite's mocks).
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const store = new InMemoryApprovalPolicyStore({
      version: 4,
      default: "agent",
      rules: [],
    });
    expect((await store.load()).default).toBe("user");
    // Said, naming the value and the version (round 13, nit 1).
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/default overridden/),
      expect.objectContaining({ storedDefault: "agent", version: 4 })
    );
    warn.mockRestore();
    expect((await store.setRules([], "admin")).default).toBe("user");
  });

  it("warns once per stored version, not on every load (round 14, item 10)", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const overridden = () =>
      warn.mock.calls.filter(([m]) => /default overridden/.test(String(m))).length;
    const store = new InMemoryApprovalPolicyStore({
      version: 71,
      default: "agent",
      rules: [],
    });
    // Every hold and every workflow step loads the policy: one warning for the version.
    for (let i = 0; i < 5; i++) expect((await store.load()).default).toBe("user");
    expect(overridden()).toBe(1);
    // Another stored version (or another value) is said again, once.
    const next = new InMemoryApprovalPolicyStore({
      version: 72,
      default: "system",
      rules: [],
    });
    await next.load();
    await next.load();
    expect(overridden()).toBe(2);
    warn.mockRestore();
  });

  it("warns once per tenant's stored version: two tenants with the same version are two (round 15, I-7)", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const overridden = () =>
      warn.mock.calls.filter(([m]) => /default overridden/.test(String(m)));
    // One store instance, partitioned by tenant; each tenant's own version 81.
    const store = new InMemoryApprovalPolicyStore({
      version: 81,
      default: "agent",
      rules: [],
    });
    for (const tenantId of [
      "00000000-0000-4000-8000-0000000000c1",
      "00000000-0000-4000-8000-0000000000c2",
    ])
      await runWithTenant({ tenantId, mode: "single" } as never, async () => {
        await store.load();
        await store.load();
      });
    expect(overridden()).toHaveLength(2);
    expect(overridden().map(([, f]) => (f as { tenantId?: string }).tenantId)).toEqual([
      "00000000-0000-4000-8000-0000000000c1",
      "00000000-0000-4000-8000-0000000000c2",
    ]);
    warn.mockRestore();
  });

  it("the warned-about set is bounded without flooding: a recent version is not warned again (round 16, nit 4)", async () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const overridden = () =>
      warn.mock.calls.filter(([m]) => /default overridden/.test(String(m))).length;
    const load = (version: number) =>
      new InMemoryApprovalPolicyStore({ version, default: "agent", rules: [] }).load();
    // A full set of 100 stored versions, each warned once.
    for (let v = 9000; v < 9100; v++) await load(v);
    expect(overridden()).toBe(100);
    // The first is used again (most recent now), then one more version arrives: only the least
    // recently seen is let go — not everything at once (it cleared the whole set at 100, and every
    // version warned again).
    await load(9000);
    await load(9100);
    expect(overridden()).toBe(101);
    await load(9000);
    await load(9099);
    expect(overridden()).toBe(101);
    warn.mockRestore();
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
