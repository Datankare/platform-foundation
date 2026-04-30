/**
 * platform/social/agents/__tests__/concierge.test.ts
 *
 * Tests for the concierge agent workflow.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { createConciergeWorkflow } from "../concierge";
import type { ConciergeInput } from "@/prompts/social/concierge-v1";
import type { WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    trajectoryId: "traj-test-cn",
    identity: { actorType: "agent", actorId: "concierge", agentRole: "Concierge" },
    stepCount: 0,
    totalCostUsd: 0,
    scopeKey: "group",
    ...overrides,
  };
}

function makeMockOrchestrator(responseText: string): Orchestrator {
  const response: AIResponse = {
    content: [{ type: "text", text: responseText }],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 60, outputTokens: 80 },
    stopReason: "end_turn",
  };
  return {
    complete: jest.fn().mockResolvedValue(response),
  } as unknown as Orchestrator;
}

const INPUT: ConciergeInput = {
  groupName: "Music Lovers",
  groupDescription: "Share and discuss music",
  memberName: "Alice",
};

describe("createConciergeWorkflow", () => {
  it("step 0: gathers context and continues", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow } = createConciergeWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 0 }));

    expect(outcome.action).toBe("gather-context");
    expect(outcome.boundary).toBe("cognition");
    expect(outcome.continueExecution).toBe(true);
  });

  it("step 1: calls orchestrator and parses onboarding actions", async () => {
    const llmResponse = JSON.stringify([
      {
        id: "introduce-yourself",
        label: "Introduce yourself to the group",
        primary: true,
      },
      { id: "browse-playlist", label: "Check out the group playlist", primary: false },
      { id: "share-favorite", label: "Share your favorite song", primary: false },
    ]);
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createConciergeWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 1 }));

    expect(outcome.action).toBe("generate-onboarding");
    expect(outcome.continueExecution).toBe(false);
    expect(outcome.costUsd).toBeGreaterThan(0);
    expect(orch.complete).toHaveBeenCalledTimes(1);

    const result = getResult();
    expect(result.actions).toHaveLength(3);
    expect(result.actions[0].id).toBe("introduce-yourself");
    expect(result.actions[0].primary).toBe(true);
    expect(result.actions[1].primary).toBe(false);
  });

  it("step 1: falls back to default action on malformed response (P11)", async () => {
    const orch = makeMockOrchestrator("not valid json");
    const { workflow, getResult } = createConciergeWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    const result = getResult();
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].id).toBe("welcome-intro");
    expect(result.actions[0].primary).toBe(true);
  });

  it("step 1: falls back on empty array", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow, getResult } = createConciergeWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    const result = getResult();
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].id).toBe("welcome-intro");
  });

  it("step 1: caps at 5 actions", async () => {
    const actions = Array.from({ length: 8 }, (_, i) => ({
      id: `action-${i}`,
      label: `Action ${i}`,
      primary: i === 0,
    }));
    const orch = makeMockOrchestrator(JSON.stringify(actions));
    const { workflow, getResult } = createConciergeWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().actions).toHaveLength(5);
  });

  it("default step returns done", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow } = createConciergeWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 99 }));

    expect(outcome.action).toBe("done");
    expect(outcome.continueExecution).toBe(false);
  });
});
