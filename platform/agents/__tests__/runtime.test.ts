/**
 * platform/agents/__tests__/runtime.test.ts
 *
 * Tests for executeAgent. Covers: happy path multi-step,
 * budget exhaustion → pause, workflow error → failed,
 * unregistered agent, step limit enforcement, trajectory
 * persistence, cost accumulation.
 */

import { executeAgent } from "../runtime";
import type { WorkflowFn, StepOutcome, WorkflowContext } from "../runtime";
import { registerAgent, resetAgentRegistry } from "../registry";
import { InMemoryTrajectoryStore } from "../trajectory-store";
import { BudgetTracker } from "../budget-tracker";
import { DEFAULT_BUDGET_CONFIG } from "../types";
import type { AgentConfig, BudgetConfig } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "For testing",
    tools: [],
    budgetConfig: DEFAULT_BUDGET_CONFIG,
    ...overrides,
  };
}

/**
 * Create a workflow that runs N steps then stops.
 */
function makeCountdownWorkflow(totalSteps: number, costPerStep = 0.001): WorkflowFn {
  let remaining = totalSteps;
  return async (_ctx: WorkflowContext): Promise<StepOutcome> => {
    remaining -= 1;
    return {
      action: `step-${totalSteps - remaining}`,
      boundary: "cognition",
      input: { remaining },
      output: { done: remaining <= 0 },
      costUsd: costPerStep,
      continueExecution: remaining > 0,
    };
  };
}

/**
 * Create a workflow that fails on a specific step.
 */
function makeFailingWorkflow(failOnStep: number): WorkflowFn {
  let current = 0;
  return async (): Promise<StepOutcome> => {
    current += 1;
    if (current === failOnStep) {
      throw new Error("Workflow failed on purpose");
    }
    return {
      action: `step-${current}`,
      boundary: "cognition",
      input: {},
      output: {},
      costUsd: 0,
      continueExecution: true,
    };
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("executeAgent", () => {
  let store: InMemoryTrajectoryStore;
  let budget: BudgetTracker;

  beforeEach(() => {
    resetAgentRegistry();
    store = new InMemoryTrajectoryStore();
    budget = new BudgetTracker();
  });

  describe("happy path", () => {
    it("executes a 3-step workflow to completion", async () => {
      registerAgent(makeAgentConfig());

      const result = await executeAgent(
        "test-agent",
        "unit-test",
        "platform",
        undefined,
        makeCountdownWorkflow(3),
        store,
        budget
      );

      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(3);
      expect(result.finalStatus).toBe("completed");
      expect(result.trajectoryId).toBeTruthy();
    });

    it("records trajectory in store", async () => {
      registerAgent(makeAgentConfig());

      const result = await executeAgent(
        "test-agent",
        "unit-test",
        "platform",
        undefined,
        makeCountdownWorkflow(2),
        store,
        budget
      );

      const record = await store.getById(result.trajectoryId);
      expect(record).toBeDefined();
      expect(record!.trajectory.status).toBe("completed");
      expect(record!.trajectory.steps).toHaveLength(2);
    });

    it("accumulates cost across steps", async () => {
      registerAgent(makeAgentConfig());

      const result = await executeAgent(
        "test-agent",
        "unit-test",
        "platform",
        undefined,
        makeCountdownWorkflow(3, 0.01),
        store,
        budget
      );

      expect(result.totalCostUsd).toBeCloseTo(0.03, 4);

      const record = await store.getById(result.trajectoryId);
      expect(record!.trajectory.totalCost).toBeCloseTo(0.03, 4);
    });

    it("sets scope on trajectory", async () => {
      registerAgent(makeAgentConfig());

      const result = await executeAgent(
        "test-agent",
        "group-create",
        "group",
        "group-123",
        makeCountdownWorkflow(1),
        store,
        budget
      );

      const record = await store.getById(result.trajectoryId);
      expect(record!.scopeType).toBe("group");
      expect(record!.scopeId).toBe("group-123");
    });
  });

  describe("budget enforcement", () => {
    it("pauses when daily budget exhausted", async () => {
      const tightBudget: BudgetConfig = {
        maxCostPerTrajectory: 0.1,
        maxCostPerDay: 0.02,
        maxStepsPerTrajectory: 100,
      };
      registerAgent(makeAgentConfig({ budgetConfig: tightBudget }));

      const result = await executeAgent(
        "test-agent",
        "test",
        "platform",
        undefined,
        makeCountdownWorkflow(100, 0.01),
        store,
        budget
      );

      expect(result.success).toBe(false);
      expect(result.finalStatus).toBe("paused");
      expect(result.stepsCompleted).toBe(2);
      expect(result.error).toMatch(/budget exhausted/i);
    });

    it("stops at step limit", async () => {
      const limitedConfig: BudgetConfig = {
        maxCostPerTrajectory: 100,
        maxCostPerDay: 100,
        maxStepsPerTrajectory: 3,
      };
      registerAgent(makeAgentConfig({ budgetConfig: limitedConfig }));

      // Workflow would run forever but step limit stops it
      let stepCount = 0;
      const infiniteWorkflow: WorkflowFn = async () => {
        stepCount += 1;
        return {
          action: `step-${stepCount}`,
          boundary: "cognition",
          input: {},
          output: {},
          costUsd: 0,
          continueExecution: true, // never stops
        };
      };

      const result = await executeAgent(
        "test-agent",
        "test",
        "platform",
        undefined,
        infiniteWorkflow,
        store,
        budget
      );

      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(3);
      expect(result.finalStatus).toBe("completed");
    });
  });

  describe("error handling", () => {
    it("returns failed for unregistered agent", async () => {
      const result = await executeAgent(
        "nonexistent",
        "test",
        "platform",
        undefined,
        makeCountdownWorkflow(1),
        store,
        budget
      );

      expect(result.success).toBe(false);
      expect(result.finalStatus).toBe("failed");
      expect(result.error).toMatch(/not registered/);
    });

    it("marks trajectory as failed on workflow error", async () => {
      registerAgent(makeAgentConfig());

      const result = await executeAgent(
        "test-agent",
        "test",
        "platform",
        undefined,
        makeFailingWorkflow(2),
        store,
        budget
      );

      expect(result.success).toBe(false);
      expect(result.finalStatus).toBe("failed");
      expect(result.error).toMatch(/on purpose/);
      expect(result.stepsCompleted).toBe(1);

      const record = await store.getById(result.trajectoryId);
      expect(record!.trajectory.status).toBe("failed");
    });
  });

  describe("step recording", () => {
    it("records step boundary (P17)", async () => {
      registerAgent(makeAgentConfig());

      let callCount = 0;
      const mixedWorkflow: WorkflowFn = async () => {
        callCount += 1;
        return {
          action: callCount === 1 ? "evaluate" : "commit",
          boundary: callCount === 1 ? "cognition" : "commitment",
          input: { step: callCount },
          output: { result: "ok" },
          costUsd: 0,
          continueExecution: callCount < 2,
        };
      };

      const result = await executeAgent(
        "test-agent",
        "test",
        "platform",
        undefined,
        mixedWorkflow,
        store,
        budget
      );

      const record = await store.getById(result.trajectoryId);
      expect(record!.trajectory.steps[0].boundary).toBe("cognition");
      expect(record!.trajectory.steps[1].boundary).toBe("commitment");
    });

    it("records step duration", async () => {
      registerAgent(makeAgentConfig());

      const slowWorkflow: WorkflowFn = async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          action: "slow-step",
          boundary: "cognition" as const,
          input: {},
          output: {},
          costUsd: 0,
          continueExecution: false,
        };
      };

      const result = await executeAgent(
        "test-agent",
        "test",
        "platform",
        undefined,
        slowWorkflow,
        store,
        budget
      );

      const record = await store.getById(result.trajectoryId);
      expect(record!.trajectory.steps[0].durationMs).toBeGreaterThanOrEqual(9);
    });
  });
});
