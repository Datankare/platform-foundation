/**
 * platform/social/agents/__tests__/gatekeeper.test.ts
 *
 * Tests for the gatekeeper agent workflow.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { createGatekeeperWorkflow } from "../gatekeeper";
import type { GatekeeperInput } from "@/prompts/social/gatekeeper-v1";
import type { WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    trajectoryId: "traj-test-gk",
    identity: { actorType: "agent", actorId: "gatekeeper", agentRole: "Gatekeeper" },
    stepCount: 0,
    totalCostUsd: 0,
    scopeKey: "group",
    ...overrides,
  };
}

function makeMockOrchestrator(responseText: string): Orchestrator {
  const response: AIResponse = {
    content: [{ type: "text", text: responseText }],
    model: "claude-sonnet-4-20250514",
    usage: { inputTokens: 80, outputTokens: 40 },
    stopReason: "end_turn",
  };
  return {
    complete: jest.fn().mockResolvedValue(response),
  } as unknown as Orchestrator;
}

const INPUT: GatekeeperInput = {
  groupName: "Music Lovers",
  groupDescription: "Share and discuss music",
  applicantId: "user-99",
  applicantContext: "Interested in jazz and classical music",
};

describe("createGatekeeperWorkflow", () => {
  it("step 0: gathers context and continues", async () => {
    const orch = makeMockOrchestrator("{}");
    const { workflow } = createGatekeeperWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 0 }));

    expect(outcome.action).toBe("gather-context");
    expect(outcome.boundary).toBe("cognition");
    expect(outcome.continueExecution).toBe(true);
    expect(outcome.costUsd).toBe(0);
  });

  it("step 1: calls orchestrator and parses approve decision", async () => {
    const llmResponse = JSON.stringify({
      decision: "approve",
      confidence: 0.85,
      reason: "Strong interest match with group topic",
    });
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createGatekeeperWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 1 }));

    expect(outcome.action).toBe("evaluate-fit");
    expect(outcome.continueExecution).toBe(false);
    expect(outcome.costUsd).toBeGreaterThan(0);
    expect(orch.complete).toHaveBeenCalledTimes(1);

    const result = getResult();
    expect(result.evaluation.decision).toBe("approve");
    expect(result.evaluation.confidence).toBe(0.85);
  });

  it("step 1: handles deny decision", async () => {
    const llmResponse = JSON.stringify({
      decision: "deny",
      confidence: 0.9,
      reason: "Applicant context suggests spam",
    });
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createGatekeeperWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().evaluation.decision).toBe("deny");
  });

  it("step 1: defaults to review on malformed response (P11)", async () => {
    const orch = makeMockOrchestrator("garbage");
    const { workflow, getResult } = createGatekeeperWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().evaluation.decision).toBe("review");
    expect(getResult().evaluation.confidence).toBe(0);
  });

  it("step 1: defaults to review on invalid decision value", async () => {
    const llmResponse = JSON.stringify({
      decision: "maybe",
      confidence: 0.5,
      reason: "Uncertain",
    });
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createGatekeeperWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().evaluation.decision).toBe("review");
  });

  it("default step returns done", async () => {
    const orch = makeMockOrchestrator("{}");
    const { workflow } = createGatekeeperWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 99 }));

    expect(outcome.action).toBe("done");
    expect(outcome.continueExecution).toBe(false);
  });
});
