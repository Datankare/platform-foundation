/**
 * __tests__/contract/proposal-store-contract.ts
 * ProposalStore conformance kit — ADR-031 D2/D3/D4. Not a *.test.ts.
 *
 * The load-bearing arm is the double-decision one: a second approval of the same proposal
 * must be a no-op, not a second approval. Nothing in the type system enforces that, and an
 * implementation doing read-then-write passes every other arm.
 */

import type { AgentIdentity, ProposalStore } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

export interface ProposalStoreContractFixtures {
  makeStore: () => ProposalStore | Promise<ProposalStore>;
}

export function runProposalStoreContract(fx: ProposalStoreContractFixtures): void {
  let store: ProposalStore;

  const base = {
    operationId: "op_1",
    sessionId: "sess_1",
    trajectoryId: "traj_1",
    label: "delete_everything",
    actor,
    effects: ["restricted"] as const,
    effectiveRisk: "restricted" as const,
  };

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  describe("create", () => {
    it("starts as proposed with no decision", async () => {
      const p = await store.create({ ...base });
      expect(p.status).toBe("proposed");
      expect(p.decidedBy).toBeUndefined();
      expect(p.proposalId).toBeTruthy();
    });

    it("carries the justification record", async () => {
      const p = await store.create({ ...base, payload: { target: "all" } });
      expect(p.effects).toEqual(["restricted"]);
      expect(p.effectiveRisk).toBe("restricted");
      expect(p.actor.actorId).toBe("guardian");
      expect(p.payload).toEqual({ target: "all" });
    });

    it("issues distinct proposalIds under one operationId (D3)", async () => {
      const a = await store.create({ ...base });
      const b = await store.create({ ...base, operationId: "op_2" });
      expect(a.proposalId).not.toBe(b.proposalId);
    });

    it("records the observed version for stale-approval reconciliation (D5)", async () => {
      const p = await store.create({ ...base, observedVersion: 7 });
      expect(p.observedVersion).toBe(7);
    });
  });

  describe("decide", () => {
    it("approves a proposed proposal", async () => {
      const p = await store.create({ ...base });
      const d = await store.decide(p.proposalId, "approved", "alice", "looks fine");
      expect(d?.status).toBe("approved");
      expect(d?.decidedBy).toBe("alice");
      expect(d?.decisionNote).toBe("looks fine");
    });

    it("rejects, and the record survives (D8 — rejected reasoning is auditable)", async () => {
      const p = await store.create({ ...base });
      await store.decide(p.proposalId, "rejected", "alice", "too risky");
      const after = await store.getById(p.proposalId);
      expect(after?.status).toBe("rejected");
      expect(after?.decisionNote).toBe("too risky");
    });

    it("is a no-op on a second decision (D4)", async () => {
      const p = await store.create({ ...base });
      const first = await store.decide(p.proposalId, "approved", "alice");
      const second = await store.decide(p.proposalId, "rejected", "bob");
      expect(first?.status).toBe("approved");
      expect(second).toBeUndefined();
      const after = await store.getById(p.proposalId);
      expect(after?.status).toBe("approved");
      expect(after?.decidedBy).toBe("alice");
    });

    it("lets only one of two concurrent decisions win", async () => {
      const p = await store.create({ ...base });
      const results = await Promise.all([
        store.decide(p.proposalId, "approved", "alice"),
        store.decide(p.proposalId, "rejected", "bob"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("returns undefined for an unknown proposal", async () => {
      expect(
        await store.decide("00000000-0000-4000-8000-000000000000", "approved", "alice")
      ).toBeUndefined();
    });
  });

  describe("query", () => {
    it("filters by status", async () => {
      const a = await store.create({ ...base });
      await store.create({ ...base, operationId: "op_2" });
      await store.decide(a.proposalId, "approved", "alice");
      expect(await store.query({ status: "proposed" })).toHaveLength(1);
      expect(await store.query({ status: "approved" })).toHaveLength(1);
    });

    it("filters by operationId and trajectoryId", async () => {
      await store.create({ ...base });
      await store.create({ ...base, operationId: "op_2", trajectoryId: "traj_2" });
      expect(await store.query({ operationId: "op_1" })).toHaveLength(1);
      expect(await store.query({ trajectoryId: "traj_2" })).toHaveLength(1);
    });

    it("filters by trajectoryId alone, across operations", async () => {
      // Two operations sharing one trajectory: the trajectoryId filter must stand on its
      // own, not only as a narrowing of an operationId match.
      await store.create({ ...base, operationId: "op_1", trajectoryId: "traj_shared" });
      await store.create({ ...base, operationId: "op_2", trajectoryId: "traj_shared" });
      await store.create({ ...base, operationId: "op_3", trajectoryId: "traj_other" });

      const shared = await store.query({ trajectoryId: "traj_shared" });

      expect(shared).toHaveLength(2);
      expect(shared.map((p) => p.operationId).sort()).toEqual(["op_1", "op_2"]);
    });

    it("applies operationId and trajectoryId together, not either-or", async () => {
      await store.create({ ...base, operationId: "op_1", trajectoryId: "traj_1" });
      await store.create({ ...base, operationId: "op_2", trajectoryId: "traj_1" });
      await store.create({ ...base, operationId: "op_1", trajectoryId: "traj_2" });

      const both = await store.query({ operationId: "op_1", trajectoryId: "traj_2" });

      expect(both).toHaveLength(1);
      expect(both[0].operationId).toBe("op_1");
      expect(both[0].trajectoryId).toBe("traj_2");
    });

    it("honours limit", async () => {
      await store.create({ ...base });
      await store.create({ ...base, operationId: "op_2" });
      expect(await store.query({ limit: 1 })).toHaveLength(1);
    });
  });
}
