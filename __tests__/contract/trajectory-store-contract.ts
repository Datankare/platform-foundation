/**
 * __tests__/contract/trajectory-store-contract.ts
 * TrajectoryStore conformance kit (TCK) — ADR-027 + ADR-029 D4. Not a *.test.ts.
 *
 * Every arm must hold for both the in-memory and the Supabase implementation. The
 * subject arms are the load-bearing ones: before ADR-029 D4 a session trajectory was
 * written with its sessionId in the agentId field, which type-checked and made the two
 * kinds indistinguishable. A store that cannot separate them must not register.
 *
 * TASK-230 (ADR-059): an append answers where the step went (AppendedStep), never the segment's
 * steps; a list (query) reads no steps and gives their count; one segment's steps are read with
 * getById / chainTail / chainSegment; retention is bounded by trajectories and by their steps and
 * says `more` when either bound left one.
 */

import type { Step } from "@/platform/agents/types";
import type { TrajectoryStore } from "@/platform/agents/trajectory-store";
import { TRAJECTORY_MAX_STEPS } from "@/platform/errors/json-limits";

/** Wait until the clock has moved past `iso` (updated_at ordering between two writes). */
async function after(iso: string): Promise<void> {
  while (new Date().toISOString() <= iso) await new Promise((r) => setTimeout(r, 2));
}

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
      await store.addStep(id, makeStep(1, 0.75));
      const loaded = await store.getById(id);
      expect(loaded?.trajectory.steps).toHaveLength(2);
      expect(loaded?.trajectory.totalCost).toBeCloseTo(1.0, 6);
      expect(loaded?.costSummary.usd).toBeCloseTo(1.0, 6);
      expect(loaded?.costSummary.apiCalls).toBe(2);
    });

    it("(TASK-230) answers where the step went — segment, place in the run, a moving version — never the steps", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      const first = await store.addStep(id, makeStep(0));
      const second = await store.addStep(id, makeStep(1));
      expect(first).toMatchObject({ trajectoryId: id, segment: 1, stepIndex: 0 });
      expect(second).toMatchObject({ trajectoryId: id, segment: 1, stepIndex: 1 });
      expect(second!.version).toBeGreaterThan(first!.version);
      expect(Object.keys(second!).sort()).toEqual([
        "segment",
        "stepIndex",
        "trajectoryId",
        "version",
      ]);
    });

    it("(TASK-230) the step's place is the store's: a step claiming another index lands next", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      await store.addStep(id, makeStep(0));
      const placed = await store.addStep(id, makeStep(41));
      expect(placed?.stepIndex).toBe(1);
      expect((await store.getById(id))?.trajectory.steps.map((s) => s.action)).toEqual([
        "action-0",
        "action-41",
      ]);
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

  describe("updateStatus compare-and-set (TASK-175; review 16 L6 — a MUST for resumes)", () => {
    it("declares supportsStatusCas: true (resumeApprovedAction refuses a store that does not)", () => {
      expect(store.supportsStatusCas).toBe(true);
    });

    it("moves only from one of `from`; otherwise answers undefined and changes nothing", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      await store.updateStatus(id, "completed");
      await expect(
        store.updateStatus(id, "paused", { from: ["running", "paused"] })
      ).resolves.toBeUndefined();
      expect((await store.getById(id))?.trajectory.status).toBe("completed");
      const moved = await store.updateStatus(id, "failed", { from: ["completed"] });
      expect(moved?.trajectory.status).toBe("failed");
      expect((await store.getById(id))?.trajectory.status).toBe("failed");
    });

    it("of concurrent moves from one status, exactly one applies", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      const results = await Promise.all(
        (["completed", "paused", "failed", "awaiting_retry"] as const).map((to) =>
          store.updateStatus(id, to, { from: ["running"] })
        )
      );
      const applied = results.filter((r) => r !== undefined);
      expect(applied).toHaveLength(1);
      expect((await store.getById(id))?.trajectory.status).toBe(
        applied[0]!.trajectory.status
      );
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

  describe("chains (review 12 M1, M2)", () => {
    it("a trajectory never continued is its own tail and its only segment", async () => {
      const rec = await store.create({ kind: "agent", id: "a" }, "t", "platform");
      const id = rec.trajectory.trajectoryId;
      await store.addStep(id, makeStep(0));
      expect((await store.chainTail(id))?.trajectory.trajectoryId).toBe(id);
      expect((await store.chainSegment(id, 1))?.trajectory.trajectoryId).toBe(id);
      expect(await store.chainSegment(id, 2)).toBeUndefined();
      expect(await store.chainSegment(id, 0)).toBeUndefined();
      expect(
        await store.chainTail("00000000-0000-4000-8000-000000000000")
      ).toBeUndefined();
    });

    it("(TASK-230) a query reads no steps: each record with steps [] and its stepCount", async () => {
      const rec = await store.create({ kind: "session", id: "ws" }, "t", "user");
      await store.addStep(rec.trajectory.trajectoryId, makeStep(0));
      await store.addStep(rec.trajectory.trajectoryId, makeStep(1));
      const [found] = await store.query({ subjectId: "ws" });
      expect(found.trajectory.trajectoryId).toBe(rec.trajectory.trajectoryId);
      expect(found.trajectory.steps).toEqual([]);
      expect(found.trajectory.stepCount).toBe(2);
      // One segment's steps come with it, read alone.
      expect(
        (await store.getById(rec.trajectory.trajectoryId))?.trajectory.steps
      ).toHaveLength(2);
    });

    it("every append goes to the chain's tail, through any segment's id", async () => {
      const rec = await store.create({ kind: "agent", id: "chain" }, "t", "platform");
      const first = rec.trajectory.trajectoryId;
      for (let i = 0; i < TRAJECTORY_MAX_STEPS; i++) {
        await store.addStep(first, makeStep(i));
      }
      await expect(
        store.addStep(first, makeStep(TRAJECTORY_MAX_STEPS))
      ).rejects.toMatchObject({
        code: "request.trajectory_full",
      });
      const second = await store.addStep(first, makeStep(TRAJECTORY_MAX_STEPS), {
        rollover: true,
      });
      expect(second?.segment).toBe(2);
      expect(second?.stepIndex).toBe(TRAJECTORY_MAX_STEPS);
      expect((await store.getById(second!.trajectoryId))?.trajectory.stepOffset).toBe(
        TRAJECTORY_MAX_STEPS
      );
      // Through the first segment's id, with or without rollover: the tail.
      const third = await store.addStep(first, makeStep(TRAJECTORY_MAX_STEPS + 1));
      expect(third?.trajectoryId).toBe(second?.trajectoryId);
      expect(third?.stepIndex).toBe(TRAJECTORY_MAX_STEPS + 1);
      const tail = await store.chainTail(first);
      expect(tail?.trajectory.steps.map((s) => s.stepIndex)).toEqual([
        TRAJECTORY_MAX_STEPS,
        TRAJECTORY_MAX_STEPS + 1,
      ]);
      expect(
        (await store.chainSegment(tail!.trajectory.trajectoryId, 1))?.trajectory
          .trajectoryId
      ).toBe(first);
    }, 120_000);
  });

  describe("retention (TASK-230: bounded by trajectories and by their steps; confirmation CB3-4)", () => {
    it("deletes the due ones oldest first while their steps fit, the first always, and says more", async () => {
      const ids: string[] = [];
      for (const n of [3, 3, 3]) {
        const rec = await store.create({ kind: "agent", id: "r" }, "t", "platform");
        for (let i = 0; i < n; i++)
          await store.addStep(rec.trajectory.trajectoryId, makeStep(i));
        const done = await store.updateStatus(rec.trajectory.trajectoryId, "completed");
        ids.push(rec.trajectory.trajectoryId);
        await after(done!.trajectory.updatedAt);
      }
      const cutoff = new Date(Date.now() + 60_000);
      // Steps bound 5: the first (3) always, the second would make 6 — left; more.
      expect(await store.deleteFinishedBefore(cutoff, 10, 5)).toEqual({
        deleted: 1,
        more: true,
      });
      expect(await store.getById(ids[0])).toBeUndefined();
      expect(await store.getById(ids[1])).toBeDefined();
      // Steps bound 1: the first always goes, even past it.
      expect(await store.deleteFinishedBefore(cutoff, 10, 1)).toEqual({
        deleted: 1,
        more: true,
      });
      // The trajectory bound: one; nothing due is left.
      const more = await store.deleteFinishedBefore(cutoff, 1, 1_000);
      expect(more).toEqual({ deleted: 1, more: false });
      expect(await store.deleteFinishedBefore(cutoff, 10, 1_000)).toEqual({
        deleted: 0,
        more: false,
      });
    });

    it("says more when the trajectory bound left a due one", async () => {
      for (let i = 0; i < 2; i++) {
        const rec = await store.create({ kind: "agent", id: "m" }, "t", "platform");
        await store.updateStatus(rec.trajectory.trajectoryId, "failed");
      }
      const cutoff = new Date(Date.now() + 60_000);
      expect(await store.deleteFinishedBefore(cutoff, 1)).toEqual({
        deleted: 1,
        more: true,
      });
      expect(await store.deleteFinishedBefore(cutoff, 1)).toEqual({
        deleted: 1,
        more: false,
      });
    });
  });
}
