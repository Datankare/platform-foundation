/**
 * platform/agents/__tests__/workflow-loop.test.ts
 *
 * Unit arms for the workflow registry and the loop's refusal paths. The conformance kit
 * (__tests__/agent-response-conformance.test.ts) exercises the happy paths of both entry
 * points; these cover what it does not reach — the fail-closed cases, which are the ones
 * that matter when a goal is misconfigured.
 */

import {
  advanceGoal,
  listWorkflowGoals,
  registerWorkflow,
  resetWorkflowRegistry,
  resolveWorkflow,
  runGoal,
  type WorkflowDefinition,
} from "../workflow-loop";
import { InMemoryTrajectoryStore } from "../trajectory-store";
import type { AgentIdentity, Tool } from "@/platform/kernel";

const ACTOR: AgentIdentity = {
  actorType: "agent",
  actorId: "unit",
  agentRole: "unit",
};

function stepTool(id: string): Tool {
  return {
    id,
    name: id,
    description: id,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    outputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    effects: [],
    execute: async (input) => ({ text: String(input.text) }),
  };
}

function definition(goal: WorkflowDefinition["goal"]): WorkflowDefinition {
  return {
    goal,
    description: goal,
    endpoint: "/api/agent/process-content",
    steps: [
      {
        tool: stepTool(`${goal}-step`),
        intent: "inform",
        estimatedCostUSD: 0.001,
        input: (ctx) => ({ text: String(ctx.input.text ?? "x") }),
      },
    ],
  };
}

describe("workflow registry", () => {
  beforeEach(() => {
    resetWorkflowRegistry();
  });

  it("registers and resolves a definition", () => {
    registerWorkflow(definition("translate"));
    expect(resolveWorkflow("translate").goal).toBe("translate");
  });

  it("refuses a duplicate goal", () => {
    registerWorkflow(definition("translate"));
    expect(() => registerWorkflow(definition("translate"))).toThrow(/already registered/);
  });

  it("refuses a definition with no steps", () => {
    expect(() => registerWorkflow({ ...definition("speak"), steps: [] })).toThrow(
      /no steps/
    );
  });

  it("throws on an unregistered goal rather than answering emptily", () => {
    // Fail closed (ADR-029 D1): a surface that ignores an unknown goal answers wrongly
    // forever; one that refuses fails once, loudly.
    expect(() => resolveWorkflow("analyze")).toThrow(/not registered/);
  });

  it("lists what it has, and nothing else", () => {
    registerWorkflow(definition("translate"));
    registerWorkflow(definition("speak"));
    expect([...listWorkflowGoals()].sort()).toEqual(["speak", "translate"]);
  });

  it("reset empties it", () => {
    registerWorkflow(definition("translate"));
    resetWorkflowRegistry();
    expect(listWorkflowGoals()).toEqual([]);
  });
});

describe("workflow loop refusal paths", () => {
  let store: InMemoryTrajectoryStore;

  beforeEach(() => {
    resetWorkflowRegistry();
    registerWorkflow(definition("translate"));
    store = new InMemoryTrajectoryStore();
  });

  it("throws when asked to continue a trajectory that does not exist", async () => {
    await expect(
      runGoal({
        goal: "translate",
        input: { text: "hi" },
        actor: ACTOR,
        trajectoryId: "traj_missing",
        trajectoryStore: store,
      })
    ).rejects.toThrow(/trajectory not found/);
  });

  it("advancing a finished workflow adds no step and offers only done", async () => {
    const first = await advanceGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: ACTOR,
      trajectoryStore: store,
    });
    expect(first.trajectory.steps).toHaveLength(1);

    const second = await advanceGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: ACTOR,
      trajectoryId: first.trajectory.trajectoryId,
      trajectoryStore: store,
    });
    expect(second.trajectory.steps).toHaveLength(1);
    expect(second.nextActions.map((a) => a.action)).toEqual(["done"]);
  });

  it("pauses rather than fails when the ceiling binds (ADR-029 D8)", async () => {
    const response = await runGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: ACTOR,
      budgetMaxUSD: 0.0000001,
      trajectoryStore: store,
    });
    expect(response.trajectory.status).toBe("paused");
    expect(response.trajectory.steps).toHaveLength(0);
    expect(response.cost.estimatedCostUSD).toBe(0);
    // Paused is recoverable, so the affordance is retry — not a dead end.
    expect(response.nextActions.map((a) => a.action)).toContain("retry");
  });

  it("threads one trajectory across choreographed hops", async () => {
    const first = await advanceGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: ACTOR,
      trajectoryStore: store,
    });
    const second = await advanceGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: ACTOR,
      trajectoryId: first.trajectory.trajectoryId,
      trajectoryStore: store,
    });
    expect(second.trajectory.trajectoryId).toBe(first.trajectory.trajectoryId);
  });

  it("sums cost from the trajectory, not from the declaration", async () => {
    const response = await runGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: ACTOR,
      trajectoryStore: store,
    });
    const recorded = response.trajectory.steps.reduce((sum, s) => sum + s.cost, 0);
    expect(response.cost.estimatedCostUSD).toBeCloseTo(recorded, 9);
    expect(response.cost.apiCalls).toBe(response.trajectory.steps.length);
  });
});
