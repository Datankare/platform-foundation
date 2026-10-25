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
import { getBudgetTracker, resetBudgetTracker } from "../budget-tracker";
import type { AgentIdentity, Tool } from "@/platform/kernel";
import { withModules, WORKFLOW_GOALS_FIXTURE } from "@/__tests__/helpers/modules";

// The goals these fixtures use are declared by a fixture module, not a product module (ADR-054).
withModules([WORKFLOW_GOALS_FIXTURE]);

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

  it("refuses a goal neither the core nor a registered module declares (ADR-054 D4)", () => {
    expect(() => registerWorkflow(definition("summarise" as never))).toThrow(
      /workflow goal summarise is not declared by the core or a registered module \(declared: analyze, translate, /
    );
    expect(listWorkflowGoals()).toEqual([]);
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

describe("budgets are cumulative and governed (audit C-8)", () => {
  /** A workflow of `n` steps, each declaring `cost`. */
  function costly(n: number, cost: number): WorkflowDefinition {
    return {
      ...definition("translate"),
      steps: Array.from({ length: n }, (_, i) => ({
        tool: stepTool(`costly-${i}`),
        intent: "inform" as const,
        estimatedCostUSD: cost,
        input: () => ({ text: `s${i}` }),
      })),
    };
  }

  beforeEach(() => {
    resetWorkflowRegistry();
    resetBudgetTracker();
  });

  it("stops a workflow whose steps together exceed the ceiling, though each is under it", async () => {
    registerWorkflow(costly(10, 0.4));
    const response = await runGoal({
      goal: "translate",
      input: {},
      actor: ACTOR,
      budgetMaxUSD: 1,
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    // 0.4 + 0.4 = 0.8; a third would be 1.2 > 1.
    expect(
      response.trajectory.steps.filter((s) => s.boundary === "commitment")
    ).toHaveLength(2);
    expect(response.trajectory.status).toBe("paused");
  });

  it("counts the hops before this one when choreographed", async () => {
    registerWorkflow(costly(5, 0.4));
    const store = new InMemoryTrajectoryStore();
    let response = await advanceGoal({
      goal: "translate",
      input: {},
      actor: ACTOR,
      budgetMaxUSD: 1,
      trajectoryStore: store,
    });
    for (let hop = 0; hop < 4; hop++) {
      response = await advanceGoal({
        goal: "translate",
        input: {},
        actor: ACTOR,
        budgetMaxUSD: 1,
        trajectoryId: response.trajectory.trajectoryId,
        trajectoryStore: store,
      });
    }
    expect(
      response.trajectory.steps.filter((s) => s.boundary === "commitment")
    ).toHaveLength(2);
  });

  it("is bounded by the actor's governed daily budget when no ceiling is given", async () => {
    registerWorkflow(costly(3, 0.01));
    const tracker = getBudgetTracker();
    jest.spyOn(tracker, "checkBudget").mockResolvedValueOnce({
      allowed: true,
    } as never);
    jest.spyOn(tracker, "checkBudget").mockResolvedValueOnce({
      allowed: false,
      reason: "daily cost cap reached",
    } as never);
    const consume = jest.spyOn(tracker, "consume");
    const response = await runGoal({
      goal: "translate",
      input: {},
      actor: ACTOR,
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    expect(
      response.trajectory.steps.filter((s) => s.boundary === "commitment")
    ).toHaveLength(1);
    expect(response.trajectory.status).toBe("paused");
    expect(consume).toHaveBeenCalledWith("unit", "platform", undefined, 0.01);
  });

  it("pauses, spending nothing, when the budget cannot be read (fail closed)", async () => {
    registerWorkflow(costly(2, 0.01));
    jest
      .spyOn(getBudgetTracker(), "checkBudget")
      .mockRejectedValueOnce(new Error("db down"));
    const response = await runGoal({
      goal: "translate",
      input: {},
      actor: ACTOR,
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    expect(response.trajectory.steps).toHaveLength(0);
    expect(response.trajectory.status).toBe("paused");
  });

  it("charges a user's agent to the user's budget scope", async () => {
    registerWorkflow(costly(1, 0.02));
    const consume = jest.spyOn(getBudgetTracker(), "consume");
    await runGoal({
      goal: "translate",
      input: {},
      actor: { ...ACTOR, onBehalfOf: "user-7" },
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    expect(consume).toHaveBeenCalledWith("unit", "user", "user-7", 0.02);
  });
});

describe("a delegated agent stays within its consented scope (audit C-2)", () => {
  beforeEach(() => {
    resetWorkflowRegistry();
    resetBudgetTracker();
    registerWorkflow({ ...definition("translate"), requiredCapability: "translate.run" });
  });

  const delegated = (scope: string[]): AgentIdentity => ({
    ...ACTOR,
    onBehalfOf: "user-9",
    delegation: { onBehalfOf: "user-9", scope, method: "oauth2.1-pkce" },
  });

  it("denies a capability outside the delegation's scope, even when the agent holds it", async () => {
    const response = await runGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: delegated(["something.else"]),
      checkCapability: async () => true,
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    expect(response.capabilityCheck).toMatchObject({ state: "denied" });
    expect(response.trajectory.steps).toHaveLength(0);
  });

  it("grants one inside it", async () => {
    const response = await runGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: delegated(["translate.run"]),
      checkCapability: async () => true,
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    expect(response.capabilityCheck).toMatchObject({ state: "granted" });
  });

  it("never grants on scope alone: the capability check still decides", async () => {
    const response = await runGoal({
      goal: "translate",
      input: { text: "hi" },
      actor: delegated(["translate.run"]),
      checkCapability: async () => false,
      trajectoryStore: new InMemoryTrajectoryStore(),
    });
    expect(response.capabilityCheck).toMatchObject({ state: "denied" });
  });
});
