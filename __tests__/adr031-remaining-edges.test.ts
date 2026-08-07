/**
 * __tests__/adr031-remaining-edges.test.ts
 *
 * ADR-031 D4's last two edges. The ADR names five points where a retry must find its
 * predecessor rather than create a sibling; three had arms, these two had correct behaviour
 * and nothing asserting it.
 *
 *   approved -> committed   a retry of an approved commit does not apply twice
 *   effected -> recorded    a trajectory records an operation once, not once per attempt
 */

import { repairSession } from "@/platform/action-pipeline";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import type { AgentIdentity } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

describe("D4 — approved to committed", () => {
  let store: InMemoryActivityStateStore<{ n: number }>;

  beforeEach(async () => {
    store = new InMemoryActivityStateStore<{ n: number }>();
    await store.create("sess_1", { n: 0 });
  });

  it("a retry at the same version does not apply twice", async () => {
    const first = await store.commit("sess_1", 1, { n: 1 }, "op_1");
    expect(first.ok).toBe(true);

    // The retry carries the same identity AND the same expected version, because the caller
    // never saw the first succeed. The CAS is what stops it: the version has moved.
    const retry = await store.commit("sess_1", 1, { n: 1 }, "op_1");

    expect(retry.ok).toBe(false);
    const loaded = await store.load("sess_1");
    expect(loaded?.version).toBe(2);
    expect(loaded?.state.n).toBe(1);
  });

  it("the retry sees the state its predecessor produced", async () => {
    await store.commit("sess_1", 1, { n: 1 }, "op_1");
    const retry = await store.commit("sess_1", 1, { n: 1 }, "op_1");

    // Not merely refused — refused WITH the winning state, so a caller can tell its own
    // commit landed rather than assuming it failed and firing again.
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.currentVersion).toBe(2);
      expect(retry.currentState.n).toBe(1);
    }
  });

  it("producedBy names the operation that won", async () => {
    await store.commit("sess_1", 1, { n: 1 }, "op_1");
    const loaded = await store.load("sess_1");
    // The link that makes the recorded edge checkable at all: without it, a commit and its
    // trajectory step cannot be matched.
    expect(loaded?.producedBy).toBe("op_1");
  });
});

describe("D4 — effected to recorded", () => {
  let stateStore: InMemoryActivityStateStore<{ n: number }>;
  let trajectoryStore: InMemoryTrajectoryStore;
  let trajectoryId: string;

  beforeEach(async () => {
    stateStore = new InMemoryActivityStateStore<{ n: number }>();
    trajectoryStore = new InMemoryTrajectoryStore();
    await stateStore.create("sess_1", { n: 0 });
    const rec = await trajectoryStore.create(
      { kind: "session", id: "sess_1" },
      "t",
      "user"
    );
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function repair() {
    return repairSession({
      sessionId: "sess_1",
      trajectoryId,
      actor,
      stateStore: stateStore as never,
      trajectoryStore,
    });
  }

  it("records an operation once however many times repair runs", async () => {
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_1");

    await repair();
    await repair();
    await repair();

    const rec = await trajectoryStore.getById(trajectoryId);
    const forOp = rec?.trajectory.steps.filter((s) => s.operationId === "op_1") ?? [];
    expect(forOp).toHaveLength(1);
  });

  it("does not record an operation that already has a step", async () => {
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_1");
    await trajectoryStore.addStep(trajectoryId, {
      stepIndex: 0,
      action: "commit",
      input: {},
      output: {},
      cost: 0,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      boundary: "commitment",
      operationId: "op_1",
    });

    const outcome = await repair();

    expect(outcome.repaired).toBe(false);
    expect(outcome.reason).toBe("already recorded");
    const rec = await trajectoryStore.getById(trajectoryId);
    expect(rec?.trajectory.steps).toHaveLength(1);
  });

  it("records a NEW operation even when an older one is already recorded", async () => {
    // Dedup is per operation, not per session: the check must not become "this trajectory
    // has steps, so nothing to do".
    await stateStore.commit("sess_1", 1, { n: 1 }, "op_1");
    await repair();
    await stateStore.commit("sess_1", 2, { n: 2 }, "op_2");
    await repair();

    const rec = await trajectoryStore.getById(trajectoryId);
    const ids = rec?.trajectory.steps.map((s) => s.operationId) ?? [];
    expect(ids).toEqual(["op_1", "op_2"]);
  });
});
