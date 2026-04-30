/**
 * platform/social/agents/__tests__/matchmaker.test.ts
 *
 * Tests for the matchmaker agent workflow.
 * Uses mock orchestrator — no real LLM calls.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { createMatchmakerWorkflow } from "../matchmaker";
import type { MatchmakerInput } from "@/prompts/social/matchmaker-v1";
import type { WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    trajectoryId: "traj-test-mm",
    identity: { actorType: "agent", actorId: "matchmaker", agentRole: "Matchmaker" },
    stepCount: 0,
    totalCostUsd: 0,
    scopeKey: "user",
    ...overrides,
  };
}

function makeMockOrchestrator(responseText: string): Orchestrator {
  const response: AIResponse = {
    content: [{ type: "text", text: responseText }],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: "end_turn",
  };
  return {
    complete: jest.fn().mockResolvedValue(response),
  } as unknown as Orchestrator;
}

const INPUT: MatchmakerInput = {
  userId: "user-1",
  userInterests: ["music", "photography"],
  candidateGroups: [
    { id: "g1", name: "Music Lovers", description: "Share music", memberCount: 10 },
    {
      id: "g2",
      name: "Photo Club",
      description: "Photography enthusiasts",
      memberCount: 5,
    },
  ],
};

describe("createMatchmakerWorkflow", () => {
  it("step 0: gathers candidates and continues", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow } = createMatchmakerWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 0 }));

    expect(outcome.action).toBe("gather-candidates");
    expect(outcome.boundary).toBe("cognition");
    expect(outcome.costUsd).toBe(0);
    expect(outcome.continueExecution).toBe(true);
    expect(outcome.output).toEqual({ candidateCount: 2 });
  });

  it("step 0: stops when no candidate groups", async () => {
    const orch = makeMockOrchestrator("[]");
    const emptyInput: MatchmakerInput = { ...INPUT, candidateGroups: [] };
    const { workflow } = createMatchmakerWorkflow(emptyInput, orch);

    const outcome = await workflow(makeContext({ stepCount: 0 }));

    expect(outcome.continueExecution).toBe(false);
  });

  it("step 1: calls orchestrator and parses recommendations", async () => {
    const llmResponse = JSON.stringify([
      { groupId: "g1", score: 0.9, reason: "Music interest match" },
      { groupId: "g2", score: 0.7, reason: "Photography match" },
    ]);
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createMatchmakerWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 1 }));

    expect(outcome.action).toBe("recommend-groups");
    expect(outcome.boundary).toBe("cognition");
    expect(outcome.continueExecution).toBe(false);
    expect(outcome.costUsd).toBeGreaterThan(0);
    expect(outcome.output).toEqual({ recommendationCount: 2 });
    expect(orch.complete).toHaveBeenCalledTimes(1);

    const result = getResult();
    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations[0].groupId).toBe("g1");
    expect(result.recommendations[0].score).toBe(0.9);
  });

  it("step 1: handles empty LLM response gracefully", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow, getResult } = createMatchmakerWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().recommendations).toHaveLength(0);
  });

  it("step 1: handles malformed LLM response gracefully (P11)", async () => {
    const orch = makeMockOrchestrator("not json at all");
    const { workflow, getResult } = createMatchmakerWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().recommendations).toHaveLength(0);
  });

  it("step 1: filters out low-score recommendations", async () => {
    const llmResponse = JSON.stringify([
      { groupId: "g1", score: 0.9, reason: "Great match" },
      { groupId: "g2", score: 0.1, reason: "Weak match" },
    ]);
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createMatchmakerWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().recommendations).toHaveLength(1);
    expect(getResult().recommendations[0].groupId).toBe("g1");
  });

  it("default step returns done", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow } = createMatchmakerWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 99 }));

    expect(outcome.action).toBe("done");
    expect(outcome.continueExecution).toBe(false);
  });
});
