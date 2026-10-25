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
  /**
   * Move a claimed proposal to `indeterminate` as the approval-expiry job would (review 11 H-1);
   * the arms that need one are skipped without it.
   */
  markUndecided?: (store: ProposalStore, proposalId: string) => Promise<void>;
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

    it("keeps the whole proposing identity — owner, kind, delegation, session (PF v5.1.0)", async () => {
      // The durable store once kept only id and role, so every held action read back as an
      // agent acting for nobody: ownership checks then refused every decision in production.
      const delegated: AgentIdentity = {
        actorType: "agent",
        actorId: "agent:conductor",
        agentRole: "conductor",
        onBehalfOf: "user-1",
        sessionId: "session-a",
        delegation: {
          onBehalfOf: "user-1",
          scope: ["translate"],
          method: "oauth2.1-pkce",
        },
      };
      const p = await store.create({ ...base, actor: delegated });
      expect(p.actor).toEqual(delegated);
      expect((await store.getById(p.proposalId))?.actor).toEqual(delegated);

      const person: AgentIdentity = {
        actorType: "user",
        actorId: "user-2",
        agentRole: "none",
      };
      const q = await store.create({ ...base, operationId: "op_person", actor: person });
      expect((await store.getById(q.proposalId))?.actor).toEqual(person);
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

  describe("consume (PF v5.1.0 — an approval is used once)", () => {
    it("claims an approved proposal exactly once", async () => {
      const p = await store.create({ ...base });
      await store.decide(p.proposalId, "approved", "alice");
      const first = await store.consume(p.proposalId);
      expect(first?.status).toBe("executed");
      expect(await store.consume(p.proposalId)).toBeUndefined();
      expect((await store.getById(p.proposalId))?.status).toBe("executed");
    });

    it("lets only one of two concurrent claims win", async () => {
      const p = await store.create({ ...base });
      await store.decide(p.proposalId, "approved", "alice");
      const results = await Promise.all([
        store.consume(p.proposalId),
        store.consume(p.proposalId),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("claims nothing that is not approved", async () => {
      const p = await store.create({ ...base });
      expect(await store.consume(p.proposalId)).toBeUndefined();
      await store.decide(p.proposalId, "rejected", "alice");
      expect(await store.consume(p.proposalId)).toBeUndefined();
      expect(await store.consume("missing")).toBeUndefined();
    });

    it("an executed proposal can no longer be decided", async () => {
      const p = await store.create({ ...base });
      await store.decide(p.proposalId, "approved", "alice");
      await store.consume(p.proposalId);
      expect(await store.decide(p.proposalId, "rejected", "bob")).toBeUndefined();
    });
  });

  describeRunClaims(() => store, base, fx);

  describe("withdraw (review 7 M7 — an approval never used can be withdrawn)", () => {
    it("rejects an approved, unused proposal, keeping who had approved it", async () => {
      const p = await store.create({ ...base });
      await store.decide(p.proposalId, "approved", "alice");
      const w = await store.withdraw(p.proposalId, "bob", "its run failed");
      expect(w?.status).toBe("rejected");
      expect(w?.decidedBy).toBe("bob");
      expect(w?.decisionNote).toMatch(
        /^Approved by alice at .+, never run; withdrawn: its run failed$/
      );
      // Rejected: it can be neither used nor withdrawn again.
      expect(await store.consume(p.proposalId)).toBeUndefined();
      expect(await store.withdraw(p.proposalId, "bob", "again")).toBeUndefined();
    });

    it("withdraws nothing that is not approved, or already used", async () => {
      const open = await store.create({ ...base, operationId: `${base.operationId}-w1` });
      expect(await store.withdraw(open.proposalId, "bob", "x")).toBeUndefined();
      expect((await store.getById(open.proposalId))?.status).toBe("proposed");
      const used = await store.create({ ...base, operationId: `${base.operationId}-w2` });
      await store.decide(used.proposalId, "approved", "alice");
      await store.consume(used.proposalId);
      expect(await store.withdraw(used.proposalId, "bob", "x")).toBeUndefined();
      expect((await store.getById(used.proposalId))?.status).toBe("executed");
      expect(await store.withdraw("missing", "bob", "x")).toBeUndefined();
    });

    it("lets only one of a withdrawal and a use win", async () => {
      const p = await store.create({ ...base, operationId: `${base.operationId}-w3` });
      await store.decide(p.proposalId, "approved", "alice");
      const [used, withdrawn] = await Promise.all([
        store.consume(p.proposalId),
        store.withdraw(p.proposalId, "bob", "x"),
      ]);
      expect([used, withdrawn].filter(Boolean)).toHaveLength(1);
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
      const first = await store.create({
        ...base,
        operationId: "op_1",
        trajectoryId: "traj_1",
      });
      await store.create({ ...base, operationId: "op_2", trajectoryId: "traj_1" });
      // One open proposal per operation (the store's one-live rule): close the first.
      await store.decide(first.proposalId, "rejected", "alice");
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

/** The claim / complete / release arms (review 10 H2, review 11 H-1). */
function describeRunClaims(
  get: () => ProposalStore,
  base: Parameters<ProposalStore["create"]>[0],
  fx: ProposalStoreContractFixtures
): void {
  describe("claim / complete / release (review 10 H2 — a failed run keeps its approval; review 11 H-1 — by the claim's token)", () => {
    const approved = async (op = "op_1") => {
      const p = await get().create({ ...base, operationId: op });
      await get().decide(p.proposalId, "approved", "alice");
      return p.proposalId;
    };
    const claimed = async (id: string) => {
      const c = await get().claim(id);
      expect(c?.status).toBe("executing");
      expect(c?.runToken).toEqual(expect.any(String));
      return c!.runToken!;
    };
    const OTHER = "00000000-0000-4000-8000-000000000000";

    it("claims an approved proposal for one run, with a token; a second claim, or a consume, wins nothing", async () => {
      const id = await approved();
      const token = await claimed(id);
      expect((await get().getById(id))?.runToken).toBe(token);
      expect(await get().claim(id)).toBeUndefined();
      expect(await get().consume(id)).toBeUndefined();
      expect(await get().withdraw(id, "bob", "x")).toBeUndefined();
      expect(await get().decide(id, "rejected", "bob")).toBeUndefined();
      expect((await get().getById(id))?.status).toBe("executing");
    });

    it("lets only one of concurrent claims win", async () => {
      const id = await approved();
      const results = await Promise.all([
        get().claim(id),
        get().claim(id),
        get().claim(id),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("a released run's approval stands, with why, and can be claimed again — with a new token", async () => {
      const id = await approved();
      const token = await claimed(id);
      const back = await get().release(id, "db blip", token);
      expect(back).toMatchObject({ status: "approved", lastRunError: "db blip" });
      expect(back?.decidedBy).toBe("alice");
      expect(await get().release(id, "again", token)).toBeUndefined();
      const second = await claimed(id);
      expect(second).not.toBe(token);
      // The first run's token ends nothing of the second run's claim.
      expect(await get().complete(id, token)).toBeUndefined();
      expect(await get().release(id, "late", token)).toBeUndefined();
      expect((await get().getById(id))?.status).toBe("executing");
    });

    it("a completed run used the approval: executed, and nothing moves it again", async () => {
      const id = await approved();
      const token = await claimed(id);
      expect(await get().complete(id, OTHER)).toBeUndefined();
      expect((await get().complete(id, token))?.status).toBe("executed");
      // The same claim completing again is the same answer; another's is nothing.
      expect((await get().complete(id, token))?.status).toBe("executed");
      expect(await get().complete(id, OTHER)).toBeUndefined();
      expect(await get().release(id, "late", token)).toBeUndefined();
      expect(await get().claim(id)).toBeUndefined();
      expect((await get().getById(id))?.status).toBe("executed");
    });

    it("of a release and a completion racing, exactly one wins", async () => {
      const id = await approved();
      const token = await claimed(id);
      const [r, c] = await Promise.all([
        get().release(id, "x", token),
        get().complete(id, token),
      ]);
      expect([r, c].filter(Boolean)).toHaveLength(1);
    });

    it("moves nothing that is not in the state it moves from", async () => {
      const p = await get().create({ ...base });
      expect(await get().claim(p.proposalId)).toBeUndefined();
      expect(await get().complete(p.proposalId, OTHER)).toBeUndefined();
      expect(await get().release(p.proposalId, "x", OTHER)).toBeUndefined();
      expect(
        await get().resolveIndeterminate(p.proposalId, "executed", "bob", "x")
      ).toBeUndefined();
      expect(await get().claim("missing")).toBeUndefined();
      expect((await get().getById(p.proposalId))?.status).toBe("proposed");
    });

    it("an operation in a run has its one live proposal: no second one", async () => {
      const id = await approved();
      await get().claim(id);
      await expect(get().create({ ...base })).rejects.toThrow();
    });

    describe("an undecided run (review 11 H-1)", () => {
      const undecided = async (op = "op_1") => {
        const id = await approved(op);
        const token = await claimed(id);
        await fx.markUndecided!(get(), id);
        expect((await get().getById(id))?.status).toBe("indeterminate");
        return { id, token };
      };
      const maybe = fx.markUndecided ? it : it.skip;

      maybe(
        "is not runnable, not decidable, and keeps its operation's one live proposal",
        async () => {
          const { id } = await undecided();
          expect(await get().claim(id)).toBeUndefined();
          expect(await get().consume(id)).toBeUndefined();
          expect(await get().withdraw(id, "bob", "x")).toBeUndefined();
          expect(await get().decide(id, "rejected", "bob")).toBeUndefined();
          await expect(get().create({ ...base })).rejects.toThrow();
        }
      );

      maybe(
        "its own run still completes it, by its token; another's does not",
        async () => {
          const { id, token } = await undecided();
          expect(await get().complete(id, OTHER)).toBeUndefined();
          expect((await get().complete(id, token))?.status).toBe("executed");
          expect(
            await get().resolveIndeterminate(id, "approved", "bob", "x")
          ).toBeUndefined();
        }
      );

      maybe("a person marks it executed: terminal, with who and why", async () => {
        const { id, token } = await undecided();
        const done = await get().resolveIndeterminate(id, "executed", "bob", "verified");
        expect(done?.status).toBe("executed");
        expect(done?.lastRunError).toContain("bob");
        expect(await get().claim(id)).toBeUndefined();
        // The run's own completion, should it end now, still lands on the same claim.
        expect((await get().complete(id, token))?.status).toBe("executed");
      });

      maybe(
        "a person approves it again: a fresh approval, and the old run's token ends nothing",
        async () => {
          const { id, token } = await undecided();
          const again = await get().resolveIndeterminate(
            id,
            "approved",
            "bob",
            "not applied"
          );
          expect(again).toMatchObject({ status: "approved", decidedBy: "bob" });
          expect(again?.runToken).toBeUndefined();
          expect(await get().complete(id, token)).toBeUndefined();
          expect(await get().release(id, "late", token)).toBeUndefined();
          const next = await claimed(id);
          expect(next).not.toBe(token);
          expect(await get().complete(id, token)).toBeUndefined();
          expect((await get().complete(id, next))?.status).toBe("executed");
        }
      );
    });
  });
}
