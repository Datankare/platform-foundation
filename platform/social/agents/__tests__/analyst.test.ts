/**
 * platform/social/agents/__tests__/analyst.test.ts
 *
 * Tests for the analyst agent workflow.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { createAnalystWorkflow } from "../analyst";
import type { AnalystInput } from "@/prompts/social/analyst-v1";
import type { WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    trajectoryId: "traj-test-an",
    identity: { actorType: "agent", actorId: "analyst", agentRole: "Analyst" },
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
    usage: { inputTokens: 120, outputTokens: 100 },
    stopReason: "end_turn",
  };
  return {
    complete: jest.fn().mockResolvedValue(response),
  } as unknown as Orchestrator;
}

const INPUT: AnalystInput = {
  groupName: "Music Lovers",
  memberCount: 25,
  recentActivitySummary: "15 posts, 40 comments, 3 new members last week",
};

describe("createAnalystWorkflow", () => {
  it("step 0: gathers metrics and continues", async () => {
    const orch = makeMockOrchestrator("{}");
    const { workflow } = createAnalystWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 0 }));

    expect(outcome.action).toBe("gather-metrics");
    expect(outcome.boundary).toBe("cognition");
    expect(outcome.continueExecution).toBe(true);
    expect(outcome.output).toEqual({ metricsReady: true });
  });

  it("step 1: calls orchestrator and parses health report", async () => {
    const llmResponse = JSON.stringify({
      status: "healthy",
      score: 0.85,
      insights: ["Active posting", "Good engagement ratio"],
      anomalies: [],
    });
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createAnalystWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 1 }));

    expect(outcome.action).toBe("analyze-health");
    expect(outcome.continueExecution).toBe(false);
    expect(outcome.costUsd).toBeGreaterThan(0);

    const result = getResult();
    expect(result.report.status).toBe("healthy");
    expect(result.report.score).toBe(0.85);
    expect(result.report.insights).toHaveLength(2);
    expect(result.report.anomalies).toHaveLength(0);
  });

  it("step 1: detects anomalies", async () => {
    const llmResponse = JSON.stringify({
      status: "at-risk",
      score: 0.5,
      insights: ["Drop in posting frequency"],
      anomalies: ["3 members left this week"],
    });
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createAnalystWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    const result = getResult();
    expect(result.report.status).toBe("at-risk");
    expect(result.report.anomalies).toHaveLength(1);
  });

  it("step 1: defaults to unknown on malformed response (P11)", async () => {
    const orch = makeMockOrchestrator("not json");
    const { workflow, getResult } = createAnalystWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    const result = getResult();
    expect(result.report.status).toBe("unknown");
    expect(result.report.score).toBe(0);
  });

  it("step 1: handles invalid status value", async () => {
    const llmResponse = JSON.stringify({
      status: "excellent",
      score: 0.95,
      insights: [],
      anomalies: [],
    });
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createAnalystWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().report.status).toBe("unknown");
  });

  it("default step returns done", async () => {
    const orch = makeMockOrchestrator("{}");
    const { workflow } = createAnalystWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 99 }));

    expect(outcome.action).toBe("done");
    expect(outcome.continueExecution).toBe(false);
  });
});
