/**
 * __tests__/contract/approval-policy-contract.ts
 * ApprovalPolicyStore conformance kit (TCK) — ADR-027 + Sprint 3c A2. Not a *.test.ts.
 *
 * Every ApprovalPolicyStore implementation (in-memory today, Supabase in A3) must pass this.
 * The versioning + atomicity arms are load-bearing: a policy change is a commitment (P17),
 * so version must advance monotonically and concurrent setRules must not lose an update or
 * duplicate a version. A store that passes single-threaded reads but drops a concurrent
 * setRules is unsafe and must not be wired in.
 */

import type {
  ApprovalPolicyStore,
  ApprovalRule,
} from "@/platform/agents/approval-policy-store";
import { resolveApprover } from "@/platform/agents/approval-policy-store";

export interface ApprovalPolicyStoreContractFixtures {
  /** Fresh store per test, seeded with the behavior-preserving default policy. */
  makeStore: () => ApprovalPolicyStore | Promise<ApprovalPolicyStore>;
}

export function runApprovalPolicyStoreContract(
  fx: ApprovalPolicyStoreContractFixtures
): void {
  let store: ApprovalPolicyStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  describe("default policy (behavior-preserving — P10)", () => {
    it("loads a default of human approval with no rules", async () => {
      const policy = await store.load();
      expect(policy.default).toBe("user");
      expect(policy.rules).toEqual([]);
      expect(policy.version).toBeGreaterThanOrEqual(1);
    });

    it("resolves every action to a human approver under the default", async () => {
      const policy = await store.load();
      expect(resolveApprover(policy, "restricted", ["restricted"]).actorType).toBe(
        "user"
      );
      expect(resolveApprover(policy, "ordinary", []).actorType).toBe("user");
    });
  });

  describe("setRules (a policy change is a commitment — P17)", () => {
    it("persists rules and advances the version", async () => {
      const before = await store.load();
      const rules: ApprovalRule[] = [{ maxRisk: "ordinary", requiredApprover: "agent" }];
      const after = await store.setRules(rules, "admin-1");
      expect(after.version).toBe(before.version + 1);
      expect(after.rules).toEqual(rules);
      expect((await store.load()).rules).toEqual(rules);
    });

    it("advances the version monotonically across successive changes", async () => {
      const v0 = (await store.load()).version;
      const a = await store.setRules(
        [{ maxRisk: "ordinary", requiredApprover: "agent" }],
        "admin-1"
      );
      const b = await store.setRules(
        [{ maxRisk: "consequential", requiredApprover: "agent" }],
        "admin-2"
      );
      expect(a.version).toBe(v0 + 1);
      expect(b.version).toBe(v0 + 2);
    });

    it("keeps the default actorType across a rules change", async () => {
      const after = await store.setRules(
        [{ maxRisk: "ordinary", requiredApprover: "agent" }],
        "admin-1"
      );
      expect(after.default).toBe("user");
    });

    it("a stored loosening rule moves resolution to an agent approver", async () => {
      await store.setRules(
        [
          {
            maxRisk: "consequential",
            effects: ["externalCall"],
            requiredApprover: "agent",
          },
        ],
        "admin-1"
      );
      const policy = await store.load();
      expect(resolveApprover(policy, "consequential", ["externalCall"]).actorType).toBe(
        "agent"
      );
      // a non-matching action still falls through to the human default
      expect(resolveApprover(policy, "restricted", ["restricted"]).actorType).toBe(
        "user"
      );
    });
  });

  describe("atomicity (concurrent policy changes — P17/P3)", () => {
    it("does not lose or duplicate a version under concurrent setRules", async () => {
      const v0 = (await store.load()).version;
      await Promise.all([
        store.setRules([{ maxRisk: "ordinary", requiredApprover: "agent" }], "admin-a"),
        store.setRules(
          [{ maxRisk: "consequential", requiredApprover: "agent" }],
          "admin-b"
        ),
      ]);
      // Two changes applied → version advanced by exactly two, and a policy is readable.
      const final = await store.load();
      expect(final.version).toBe(v0 + 2);
      expect(final.rules.length).toBeGreaterThan(0);
    });
  });
}
