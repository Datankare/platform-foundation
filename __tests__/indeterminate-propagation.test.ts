/**
 * __tests__/indeterminate-propagation.test.ts
 *
 * ADR-029 D10: `indeterminate` propagates. A workflow containing an indeterminate effect is
 * itself indeterminate and MUST NOT report completed.
 *
 * This is the arm that matters most in step 5a. Collapsing indeterminate into success or
 * failure is an at-least-once or at-most-once violation depending on which way the guess
 * falls — and the guess leaves no trace, so nothing downstream can detect it.
 */

import { executeAgent } from "@/platform/agents/runtime";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";
import { registerAgent, resetAgentRegistry } from "@/platform/agents/registry";
import { BudgetTracker } from "@/platform/agents/budget-tracker";
import type { WorkflowFn } from "@/platform/agents/runtime";

describe("D10 — indeterminate propagates to workflow status", () => {
  beforeEach(() => {
    resetAgentRegistry();
    registerAgent({
      id: "payer",
      name: "payer",
      description: "test",
      tools: [],
      budgetConfig: {
        maxCostPerTrajectory: 1,
        maxCostPerDay: 10,
        maxStepsPerTrajectory: 6,
      },
      effortTier: "standard",
    });
  });

  it("reports indeterminate, not completed, when an effect is unresolved", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const ledger = new InMemoryEffectLedger();

    const workflow: WorkflowFn = async (ctx) => {
      // The downstream neither confirmed nor denied.
      await ledger.begin({
        operationId: ctx.trajectoryId,
        effectKey: "charge",
        effectType: "externalCall",
      });
      await ledger.resolve(ctx.trajectoryId, "charge", "indeterminate", {
        error: "timeout after send",
      });
      return {
        action: "charge",
        boundary: "commitment",
        input: {},
        output: {},
        costUsd: 0,
        continueExecution: false,
      };
    };

    const result = await executeAgent(
      "payer",
      "test",
      "platform",
      undefined,
      workflow,
      trajectoryStore,
      new BudgetTracker(),
      ledger
    );

    expect(result.finalStatus).toBe("indeterminate");
    expect(result.success).toBe(false);

    const rec = await trajectoryStore.getById(result.trajectoryId);
    expect(rec?.trajectory.status).toBe("indeterminate");
  });

  it("still reports completed when every effect resolved confirmed", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const ledger = new InMemoryEffectLedger();

    const workflow: WorkflowFn = async (ctx) => {
      await ledger.begin({
        operationId: ctx.trajectoryId,
        effectKey: "charge",
        effectType: "externalCall",
      });
      await ledger.resolve(ctx.trajectoryId, "charge", "confirmed", {
        receipt: { id: "ch_1" },
      });
      return {
        action: "charge",
        boundary: "commitment",
        input: {},
        output: {},
        costUsd: 0,
        continueExecution: false,
      };
    };

    const result = await executeAgent(
      "payer",
      "test",
      "platform",
      undefined,
      workflow,
      trajectoryStore,
      new BudgetTracker(),
      ledger
    );

    expect(result.finalStatus).toBe("completed");
  });

  it("reports indeterminate for an effect left pending — silence is not success", async () => {
    const trajectoryStore = new InMemoryTrajectoryStore();
    const ledger = new InMemoryEffectLedger();

    const workflow: WorkflowFn = async (ctx) => {
      // Begun and never resolved: the process died, or the call hung. Either way nothing
      // confirmed, and reporting completed would be an at-least-once violation.
      await ledger.begin({
        operationId: ctx.trajectoryId,
        effectKey: "charge",
        effectType: "externalCall",
      });
      return {
        action: "charge",
        boundary: "commitment",
        input: {},
        output: {},
        costUsd: 0,
        continueExecution: false,
      };
    };

    const result = await executeAgent(
      "payer",
      "test",
      "platform",
      undefined,
      workflow,
      trajectoryStore,
      new BudgetTracker(),
      ledger
    );

    expect(result.finalStatus).toBe("indeterminate");
  });
});
