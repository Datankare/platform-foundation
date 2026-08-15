/**
 * __tests__/agent-response-conformance.test.ts
 *
 * Runs the AUX response kit (ADR-030 L21) against the PF-B workflow loop wired to the
 * in-memory trajectory store. Closes TASK-084 — the kit shipped one commit ago with no
 * arm, which is the artifact ADR-027 exists to eliminate.
 *
 * Playform runs this same kit against its own /api/agent/* surface to learn whether its
 * responses conform. That portability is what the kit is for; this file is our invocation.
 */

import { runAgentResponseContract } from "./contract/agent-response-contract";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import {
  advanceGoal,
  listWorkflowGoals,
  registerWorkflow,
  resetWorkflowRegistry,
  runGoal,
  type WorkflowDefinition,
} from "@/platform/agents/workflow-loop";
import type { AgentIdentity, AgentResponse, Tool } from "@/platform/kernel";

const store = new InMemoryTrajectoryStore();

const ACTOR: AgentIdentity = {
  actorType: "agent",
  actorId: "conformance",
  agentRole: "conformance",
};

/** A step tool with no effects: the gates still apply, nothing reaches outside. */
function stepTool(id: string): Tool {
  return {
    id,
    name: id,
    description: `${id} step`,
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
    execute: async (input) => ({ text: `${id}:${String(input.text)}` }),
  };
}

const FULL_PIPELINE: WorkflowDefinition = {
  goal: "full-pipeline",
  description: "identify then speak",
  endpoint: "/api/agent/process-content",
  steps: [
    {
      tool: stepTool("identify"),
      intent: "inform",
      estimatedCostUSD: 0.002,
      input: (ctx) => ({ text: String(ctx.input.text ?? "hum") }),
    },
    {
      // Reads the previous step's output, which is what proves the choreographed path
      // reconstructs context from the trajectory rather than losing it between hops.
      tool: stepTool("speak"),
      intent: "inform",
      estimatedCostUSD: 0.001,
      input: (ctx) => ({ text: String(ctx.outputs.at(-1)?.text ?? "") }),
    },
  ],
};

const TRANSLATE: WorkflowDefinition = {
  goal: "translate",
  description: "translate only",
  endpoint: "/api/agent/process-content",
  steps: [
    {
      tool: stepTool("translate"),
      intent: "inform",
      estimatedCostUSD: 0.001,
      input: (ctx) => ({ text: String(ctx.input.text ?? "") }),
    },
  ],
};

resetWorkflowRegistry();
registerWorkflow(FULL_PIPELINE);
registerWorkflow(TRANSLATE);

describe("AUX response envelope — conformance (in-memory wiring)", () => {
  runAgentResponseContract({
    runOrchestrated: (run) =>
      runGoal({
        goal: run.goal,
        input: run.input,
        actor: ACTOR,
        budgetMaxUSD: run.budgetMaxUSD,
        trajectoryStore: store,
      }),

    runChoreographed: async (run) => {
      const hops: AgentResponse<unknown>[] = [];
      let trajectoryId: string | undefined;
      // Bounded: a hop that appends no step would otherwise loop forever, and the loop's
      // own gotcha 1 says that is the failure mode to guard against.
      for (let i = 0; i < FULL_PIPELINE.steps.length + 2; i += 1) {
        const hop = await advanceGoal({
          goal: run.goal,
          input: run.input,
          actor: ACTOR,
          budgetMaxUSD: run.budgetMaxUSD,
          trajectoryId,
          trajectoryStore: store,
        });
        hops.push(hop);
        trajectoryId = hop.trajectory.trajectoryId;
        if (hop.nextActions.every((a) => a.action === "done")) break;
      }
      return hops;
    },

    getTrajectory: (trajectoryId) => store.getById(trajectoryId),
    publishedGoals: () => listWorkflowGoals(),
    orchestratedRun: { goal: "full-pipeline", input: { text: "hum" } },
    infeasibleBudgetUSD: 0.0001,
  });
});
