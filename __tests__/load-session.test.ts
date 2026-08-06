/**
 * __tests__/load-session.test.ts
 *
 * TASK-071: the framework could create a session and never resume one, which left ADR-031
 * D6's repair with no caller.
 */

import {
  createSession,
  loadSession,
  updateSessionMeta,
  resetActivityStateStore,
  getActivityStateStore,
} from "@/platform/app-framework";
import { resetTrajectoryStore } from "@/platform/agents/trajectory-store";
import type { ActivityDefinition, AgentIdentity } from "@/platform/kernel";

const alice: AgentIdentity = { actorType: "user", actorId: "alice", agentRole: "player" };
const bob: AgentIdentity = { actorType: "user", actorId: "bob", agentRole: "player" };

interface S {
  count: number;
}
type A = { by: number };

const definition: ActivityDefinition<S, A, { start: number }> = {
  id: "counter",
  capabilities: ["turn-based"],
  actions: [{ type: "increment", effects: ["stateWrite"] }],
  initialState: (c) => ({ count: c.start }),
  validateAction: () => true,
  applyAction: (s) => ({ count: s.count + 1 }),
};

describe("loadSession", () => {
  beforeEach(() => {
    resetActivityStateStore();
    resetTrajectoryStore();
  });

  async function make() {
    return createSession({
      definition,
      config: { start: 0 },
      participants: [alice, bob],
      budget: { maxCostPerTrajectory: 1, maxCostPerDay: 5, maxStepsPerTrajectory: 10 },
    });
  }

  it("reconstructs a session from its id alone", async () => {
    const created = await make();
    const loaded = await loadSession({
      sessionId: created.sessionId,
      definition,
      actor: alice,
    });

    expect(loaded).not.toBeNull();
    expect(loaded?.session.sessionId).toBe(created.sessionId);
    expect(loaded?.session.definitionId).toBe("counter");
    expect(loaded?.session.participants).toHaveLength(2);
    expect(loaded?.session.budget?.maxCostPerDay).toBe(5);
  });

  it("restores turn state — a turn-based session knows whose turn it is", async () => {
    const created = await make();
    const loaded = await loadSession({
      sessionId: created.sessionId,
      definition,
      actor: alice,
    });
    expect(loaded?.session.turn?.order).toEqual(["alice", "bob"]);
    expect(loaded?.session.turn?.currentIndex).toBe(0);
  });

  it("persists an advanced turn through updateSessionMeta", async () => {
    const created = await make();
    // dispatch() checks the turn and does not advance it; advancement is the caller's.
    const advanced = {
      ...created,
      turn: { ...created.turn!, currentIndex: 1, turnNumber: 2 },
    };
    await updateSessionMeta(advanced);

    const loaded = await loadSession({
      sessionId: created.sessionId,
      definition,
      actor: alice,
    });
    expect(loaded?.session.turn?.currentIndex).toBe(1);
    expect(loaded?.session.turn?.turnNumber).toBe(2);
  });

  it("returns null for a session that does not exist", async () => {
    expect(
      await loadSession({ sessionId: "sess_missing", definition, actor: alice })
    ).toBeNull();
  });

  it("refuses a session belonging to another definition", async () => {
    const created = await make();
    await expect(
      loadSession({
        sessionId: created.sessionId,
        definition: { ...definition, id: "other" },
        actor: alice,
      })
    ).rejects.toThrow(/belongs to definition/);
  });

  it("repairs an interrupted commit on load (ADR-031 D6)", async () => {
    const created = await make();
    // The crash window: state committed, process died before the trajectory append.
    const store = getActivityStateStore<S>();
    await store.commit(created.sessionId, 1, { count: 1 }, "op_interrupted");

    const loaded = await loadSession({
      sessionId: created.sessionId,
      definition,
      actor: alice,
    });

    expect(loaded?.repair?.repaired).toBe(true);
    expect(loaded?.repair?.operationId).toBe("op_interrupted");
    expect(
      loaded?.session.trajectory.steps.some((s) => s.operationId === "op_interrupted")
    ).toBe(true);
  });

  it("reports nothing to repair on a clean session", async () => {
    const created = await make();
    const loaded = await loadSession({
      sessionId: created.sessionId,
      definition,
      actor: alice,
    });
    expect(loaded?.repair?.repaired).toBe(false);
  });

  it("skipRepair leaves the trajectory untouched", async () => {
    const created = await make();
    const store = getActivityStateStore<S>();
    await store.commit(created.sessionId, 1, { count: 1 }, "op_interrupted");

    const loaded = await loadSession({
      sessionId: created.sessionId,
      definition,
      actor: alice,
      skipRepair: true,
    });

    expect(loaded?.repair).toBeUndefined();
    expect(loaded?.session.trajectory.steps).toHaveLength(0);
  });
});
