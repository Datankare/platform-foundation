/**
 * __tests__/compensation.test.ts
 *
 * ADR-029 D6: rollback is compensation, not reversal.
 *
 * The arms that matter are the ones proving nothing is erased — the original step and its
 * compensation both survive, linked. A history rewritten to claim the first thing never
 * happened cannot answer what was done about it.
 */

import { compensateTrajectory } from "@/platform/action-pipeline";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { registerAgent, resetAgentRegistry } from "@/platform/agents/registry";
import type { ActionSpec, AgentIdentity, Step, Tool } from "@/platform/kernel";

const actor: AgentIdentity = {
  actorType: "agent",
  actorId: "guardian",
  agentRole: "guardian",
};

const refundSpec: ActionSpec = {
  type: "refund",
  effects: ["externalCall"],
  ephemeral: false,
  commutative: false,
};

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "charge",
    name: "Charge",
    description: "Charges a card",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: ["externalCall"],
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

function committedStep(index: number, operationId: string, action: string): Step {
  return {
    stepIndex: index,
    action,
    input: {},
    output: {},
    cost: 0,
    durationMs: 1,
    timestamp: new Date().toISOString(),
    boundary: "commitment",
    operationId,
  };
}

describe("D6 — registration refuses non-compensable workflows", () => {
  beforeEach(() => {
    resetAgentRegistry();
  });

  const base = {
    id: "payer",
    name: "payer",
    description: "test",
    budgetConfig: {
      maxCostPerTrajectory: 1,
      maxCostPerDay: 10,
      maxStepsPerTrajectory: 6,
    },
  };

  it("accepts an agent whose tools are all compensable", () => {
    expect(() =>
      registerAgent({ ...base, tools: [makeTool(), makeTool({ id: "notify" })] })
    ).not.toThrow();
  });

  it("treats an absent declaration as compensable", () => {
    const tool = makeTool();
    expect(tool.compensable).toBeUndefined();
    expect(() => registerAgent({ ...base, tools: [tool] })).not.toThrow();
  });

  it("refuses an agent with a non-compensable tool, naming it", () => {
    expect(() =>
      registerAgent({
        ...base,
        tools: [makeTool(), makeTool({ id: "dispatch_parcel", compensable: false })],
      })
    ).toThrow(/dispatch_parcel/);
  });

  it("refuses at registration, before anything runs", () => {
    expect(() =>
      registerAgent({ ...base, tools: [makeTool({ compensable: false })] })
    ).toThrow(/cannot be rolled back/);
    // Nothing was registered — the refusal is total, not partial.
    expect(() => registerAgent({ ...base, tools: [makeTool()] })).not.toThrow();
  });
});

describe("D6 — compensation appends, never rewrites", () => {
  let store: InMemoryTrajectoryStore;
  let trajectoryId: string;

  beforeEach(async () => {
    store = new InMemoryTrajectoryStore();
    const rec = await store.create({ kind: "agent", id: "guardian" }, "run", "platform");
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function plan(label = "refund") {
    return (step: Step) =>
      step.boundary === "commitment"
        ? { spec: refundSpec, label, perform: async () => ({ refunded: step.action }) }
        : null;
  }

  it("keeps the original step and links the compensation to it", async () => {
    await store.addStep(trajectoryId, committedStep(0, "op_1", "charge"));

    const outcome = await compensateTrajectory({
      trajectoryId,
      trajectoryStore: store,
      actor,
      sessionId: "sess_1",
      plan: plan(),
    });

    expect(outcome.compensated).toBe(1);

    const rec = await store.getById(trajectoryId);
    expect(rec?.trajectory.steps).toHaveLength(2);
    // The original survives unchanged.
    expect(rec?.trajectory.steps[0].action).toBe("charge");
    expect(rec?.trajectory.steps[0].operationId).toBe("op_1");
    // The compensation names what it cancels and carries its own identity.
    expect(rec?.trajectory.steps[1].action).toBe("refund");
    expect(rec?.trajectory.steps[1].compensates).toBe("op_1");
    expect(rec?.trajectory.steps[1].operationId).not.toBe("op_1");
  });

  it("compensates in reverse order", async () => {
    await store.addStep(trajectoryId, committedStep(0, "op_1", "first"));
    await store.addStep(trajectoryId, committedStep(1, "op_2", "second"));

    await compensateTrajectory({
      trajectoryId,
      trajectoryStore: store,
      actor,
      sessionId: "sess_1",
      plan: plan(),
    });

    const rec = await store.getById(trajectoryId);
    // Later step compensated first: undoing the earlier one first would leave the later
    // compensation acting against a state that no longer holds.
    expect(rec?.trajectory.steps[2].compensates).toBe("op_2");
    expect(rec?.trajectory.steps[3].compensates).toBe("op_1");
  });

  it("skips cognition steps", async () => {
    await store.addStep(trajectoryId, {
      ...committedStep(0, "op_1", "think"),
      boundary: "cognition",
    });

    const outcome = await compensateTrajectory({
      trajectoryId,
      trajectoryStore: store,
      actor,
      sessionId: "sess_1",
      plan: plan(),
    });

    expect(outcome.compensated).toBe(0);
    expect(outcome.skipped).toBe(1);
  });

  it("does not compensate twice", async () => {
    await store.addStep(trajectoryId, committedStep(0, "op_1", "charge"));
    const args = {
      trajectoryId,
      trajectoryStore: store,
      actor,
      sessionId: "sess_1",
      plan: plan(),
    };

    await compensateTrajectory(args);
    const second = await compensateTrajectory(args);

    expect(second.compensated).toBe(0);
    const rec = await store.getById(trajectoryId);
    expect(rec?.trajectory.steps).toHaveLength(2);
  });

  it("records a failed compensation and keeps going", async () => {
    await store.addStep(trajectoryId, committedStep(0, "op_1", "first"));
    await store.addStep(trajectoryId, committedStep(1, "op_2", "second"));

    let calls = 0;
    const outcome = await compensateTrajectory({
      trajectoryId,
      trajectoryStore: store,
      actor,
      sessionId: "sess_1",
      plan: (step) =>
        step.boundary === "commitment"
          ? {
              spec: refundSpec,
              label: "refund",
              perform: async () => {
                calls += 1;
                if (calls === 1) throw new Error("downstream refused");
                return { refunded: step.action };
              },
            }
          : null,
    });

    // Stopping at the first failure would leave the rest both uncompensated AND
    // unrecorded, which is worse than a partial unwind with a complete account of it.
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.compensated).toBe(1);
    const rec = await store.getById(trajectoryId);
    expect(rec?.trajectory.steps).toHaveLength(4);
    expect(rec?.trajectory.steps[2].output).toMatchObject({ compensated: false });
  });

  it("refuses a plan declared non-compensable", async () => {
    await store.addStep(trajectoryId, committedStep(0, "op_1", "dispatch"));

    const outcome = await compensateTrajectory({
      trajectoryId,
      trajectoryStore: store,
      actor,
      sessionId: "sess_1",
      plan: () => ({
        spec: { ...refundSpec, compensable: false },
        label: "unrecall",
        perform: async () => ({}),
      }),
    });

    expect(outcome.compensated).toBe(0);
    expect(outcome.failures[0].error).toMatch(/non-compensable/);
  });

  it("throws on an unknown trajectory", async () => {
    await expect(
      compensateTrajectory({
        trajectoryId: "nope",
        trajectoryStore: store,
        actor,
        sessionId: "sess_1",
        plan: plan(),
      })
    ).rejects.toThrow(/not found/);
  });
});
