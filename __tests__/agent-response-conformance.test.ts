/**
 * __tests__/agent-response-conformance.test.ts
 *
 * Runs the AUX response kit (ADR-030 L21) against the PF-B workflow loop wired to the
 * in-memory trajectory + proposal stores. Closes TASK-084 — the kit shipped with no arm,
 * which is the artifact ADR-027 exists to eliminate.
 *
 * Playform runs this same kit against its own /api/agent/* surface to learn whether its
 * responses conform. That portability is what the kit is for; this file is our invocation.
 *
 * R9/R10 (gating) are wired here too: a gated goal whose first step carries a `restricted`
 * effect forces two-phase, so the loop holds it, and the fixtures exercise the held-state
 * contract and the approved-commit path (including that an UNapproved resume is refused).
 */

import { runAgentResponseContract } from "./contract/agent-response-contract";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";
import {
  advanceGoal,
  listWorkflowGoals,
  registerWorkflow,
  resetWorkflowRegistry,
  runGoal,
  type WorkflowDefinition,
} from "@/platform/agents/workflow-loop";
import { approveHeldAction } from "@/platform/agents/gating";
import type { AgentIdentity, AgentResponse, Tool } from "@/platform/kernel";

const store = new InMemoryTrajectoryStore();
const proposals = new InMemoryProposalStore();

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
    execute: async (input: Record<string, unknown>) => ({
      text: `${id}:${String(input.text)}`,
    }),
  };
}

/** A tool whose `restricted` effect forces effectiveRisk to the gating threshold. */
function gatedTool(id: string): Tool {
  return {
    ...stepTool(id),
    effects: ["restricted"],
    declaredRisk: "restricted",
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

/** A goal whose one step is gated — the loop holds it for approval. */
const ANALYZE: WorkflowDefinition = {
  goal: "analyze",
  description: "a gated single step",
  endpoint: "/api/agent/process-content",
  steps: [
    {
      tool: gatedTool("analyze"),
      intent: "inform",
      estimatedCostUSD: 0.001,
      input: (ctx) => ({ text: String(ctx.input.text ?? "") }),
    },
  ],
};

resetWorkflowRegistry();
registerWorkflow(FULL_PIPELINE);
registerWorkflow(TRANSLATE);
registerWorkflow(ANALYZE);

describe("AUX response envelope — conformance (in-memory wiring)", () => {
  runAgentResponseContract({
    runOrchestrated: (run) =>
      runGoal({
        goal: run.goal,
        input: run.input,
        actor: ACTOR,
        budgetMaxUSD: run.budgetMaxUSD,
        trajectoryStore: store,
        proposalStore: proposals,
      }),

    runChoreographed: async (run) => {
      const hops: AgentResponse<unknown>[] = [];
      let trajectoryId: string | undefined;
      for (let i = 0; i < FULL_PIPELINE.steps.length + 2; i += 1) {
        const hop = await advanceGoal({
          goal: run.goal,
          input: run.input,
          actor: ACTOR,
          budgetMaxUSD: run.budgetMaxUSD,
          trajectoryId,
          trajectoryStore: store,
          proposalStore: proposals,
        });
        hops.push(hop);
        trajectoryId = hop.trajectory.trajectoryId;
        if (hop.nextActions.every((a: { action: string }) => a.action === "done")) break;
      }
      return hops;
    },

    getTrajectory: (trajectoryId) => store.getById(trajectoryId),
    publishedGoals: () => listWorkflowGoals(),
    orchestratedRun: { goal: "full-pipeline", input: { text: "hum" } },
    infeasibleBudgetUSD: 0.0001,

    gating: {
      runGated: () =>
        runGoal({
          goal: "analyze",
          input: { text: "gate me" },
          actor: ACTOR,
          trajectoryStore: store,
          proposalStore: proposals,
        }),

      resumeWithoutApproval: async (response) => {
        // Resume the held trajectory WITHOUT approving. The gated step re-holds; it must
        // not commit or complete.
        const resumed = await runGoal({
          goal: "analyze",
          input: { text: "gate me" },
          actor: ACTOR,
          trajectoryId: response.trajectory.trajectoryId,
          trajectoryStore: store,
          proposalStore: proposals,
        });
        return {
          refused: resumed.trajectory.status !== "completed",
          completed: resumed.trajectory.status === "completed",
        };
      },

      approveThenResume: async (response) => {
        const proposalId = response.held?.proposalId;
        if (!proposalId) throw new Error("no held proposal to approve");
        await approveHeldAction({
          proposalId,
          decidedBy: "human-reviewer",
          proposalStore: proposals,
          trajectoryStore: store,
        });
        return runGoal({
          goal: "analyze",
          input: { text: "gate me" },
          actor: ACTOR,
          trajectoryId: response.trajectory.trajectoryId,
          trajectoryStore: store,
          proposalStore: proposals,
        });
      },
    },
  });
});
