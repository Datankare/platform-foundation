/**
 * __tests__/contract/trajectory-store-contract.ts
 * TrajectoryStore conformance kit (TCK) — ADR-027 + ADR-029 D4. Not a *.test.ts.
 *
 * Every arm must hold for both the in-memory and the Supabase implementation. The
 * subject arms are the load-bearing ones: before ADR-029 D4 a session trajectory was
 * written with its sessionId in the agentId field, which type-checked and made the two
 * kinds indistinguishable. A store that cannot separate them must not register.
 */

import type { Step } from "@/platform/agents/types";
import type { TrajectoryStore } from "@/platform/agents/trajectory-store";

export interface TrajectoryStoreContractFixtures {
  /** Fresh, empty store per test. */
  makeStore: () => TrajectoryStore | Promise<TrajectoryStore>;
}

function makeStep(index: number, cost = 0): Step {
  return {
    stepIndex: index,
    action: `action-${index}`,
    input: {},
    output: {},
    cost,
    durationMs: 1,
    timestamp: new Date().toISOString(),
    boundary: "cognition",
  };
}

export function runTrajectoryStoreContract(fx: TrajectoryStoreContractFixtures): void {
  let store: TrajectoryStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  describe("create", () => {
    it("records an agent subject and starts running", async () => {
      const rec = await store.create(
        { kind: "agent", id: "guardian" },
        "screen",
        "platform"
      );
      expect(rec.subject.kind).toBe("agent");
      expect(rec.subject.id).toBe("guardian");
      expect(rec.trajectory.agentId).toBe("guardian");
      expect(rec.trajectory.status).toBe("running");
      expect(rec.trajectory.steps).toEqual([]);
      expect(rec.trajectory.totalCost).toBe(0);
      expect(rec.trigger).toBe("screen");
    });

    it("records a session subject distinguishably (ADR-029 D4)", async () => {
      const rec = await store.create(
        { kind: "session", id: "sess_1" },
        "session-created",
        "user"
      );
      expect(rec.subject.kind).toBe("session");
      expect(rec.subject.id).toBe("sess_1");
    });

    it("defaults scopeId to null", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      expect(rec.scopeId).toBeNull();
    });

    it("issues distinct ids", async () => {
      const a = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const b = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      expect(a.trajectory.trajectoryId).not.toBe(b.trajectory.trajectoryId);
    });
  });

  describe("addStep", () => {
    it("appends and accumulates cost", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      await store.addStep(id, makeStep(0, 0.25));
      const after = await store.addStep(id, makeStep(1, 0.75));
      expect(after?.trajectory.steps).toHaveLength(2);
      expect(after?.trajectory.totalCost).toBeCloseTo(1.0, 6);
      expect(after?.costSummary.usd).toBeCloseTo(1.0, 6);
      expect(after?.costSummary.apiCalls).toBe(2);
    });

    it("returns undefined for an unknown trajectory", async () => {
      expect(
        await store.addStep("00000000-0000-4000-8000-000000000000", makeStep(0))
      ).toBeUndefined();
    });

    it("loses no step under concurrent appends", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => store.addStep(id, makeStep(i, 0.1)))
      );
      const loaded = await store.getById(id);
      expect(loaded?.trajectory.steps).toHaveLength(5);
      expect(loaded?.costSummary.usd).toBeCloseTo(0.5, 6);
    });
  });

  describe("updateStatus / getById", () => {
    it("moves to a terminal status and reads back", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      await store.updateStatus(id, "completed");
      const loaded = await store.getById(id);
      expect(loaded?.trajectory.status).toBe("completed");
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.getById("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    });
  });

  describe("query", () => {
    it("filters by subjectKind", async () => {
      await store.create({ kind: "agent", id: "guardian" }, "a", "platform");
      await store.create({ kind: "session", id: "sess_1" }, "b", "user");
      const sessions = await store.query({ subjectKind: "session" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].subject.id).toBe("sess_1");
    });

    it("separates an agent and a session sharing an id", async () => {
      await store.create({ kind: "agent", id: "shared" }, "agent-run", "platform");
      await store.create({ kind: "session", id: "shared" }, "session-created", "user");
      const agents = await store.query({ subjectKind: "agent", subjectId: "shared" });
      expect(agents).toHaveLength(1);
      expect(agents[0].trigger).toBe("agent-run");
    });

    it("filters by status and honours limit", async () => {
      const a = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      await store.create({ kind: "agent", id: "a" }, "t", "platform");
      await store.updateStatus(a.trajectory.trajectoryId, "failed");
      expect(await store.query({ status: "failed" })).toHaveLength(1);
      expect(await store.query({ limit: 1 })).toHaveLength(1);
    });

    it("returns everything when unfiltered", async () => {
      await store.create({ kind: "agent", id: "a" }, "t", "platform");
      await store.create({ kind: "agent", id: "b" }, "t", "platform");
      expect(await store.query({})).toHaveLength(2);
    });
  });
}
