/**
 * platform/social/agents/__tests__/curator.test.ts
 *
 * Tests for the curator agent workflow.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

import { createCuratorWorkflow } from "../curator";
import type { CuratorInput } from "@/prompts/social/curator-v1";
import type { WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    trajectoryId: "traj-test-cu",
    identity: { actorType: "agent", actorId: "curator", agentRole: "Curator" },
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
    usage: { inputTokens: 70, outputTokens: 60 },
    stopReason: "end_turn",
  };
  return {
    complete: jest.fn().mockResolvedValue(response),
  } as unknown as Orchestrator;
}

const INPUT: CuratorInput = {
  groupName: "Music Lovers",
  userId: "user-1",
  recentActivity: [
    "Alice shared a jazz playlist",
    "Bob posted about a concert",
    "Carol asked for recommendations",
  ],
};

describe("createCuratorWorkflow", () => {
  it("step 0: gathers activity and continues", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow } = createCuratorWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 0 }));

    expect(outcome.action).toBe("gather-activity");
    expect(outcome.boundary).toBe("cognition");
    expect(outcome.continueExecution).toBe(true);
    expect(outcome.output).toEqual({ activityCount: 3 });
  });

  it("step 0: stops when no recent activity", async () => {
    const orch = makeMockOrchestrator("[]");
    const emptyInput: CuratorInput = { ...INPUT, recentActivity: [] };
    const { workflow } = createCuratorWorkflow(emptyInput, orch);

    const outcome = await workflow(makeContext({ stepCount: 0 }));

    expect(outcome.continueExecution).toBe(false);
  });

  it("step 1: calls orchestrator and parses digest", async () => {
    const llmResponse = JSON.stringify([
      {
        title: "New Jazz Playlist",
        summary: "Alice shared a curated jazz collection",
        priority: "high",
      },
      {
        title: "Concert Update",
        summary: "Bob posted about an upcoming concert",
        priority: "medium",
      },
    ]);
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createCuratorWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 1 }));

    expect(outcome.action).toBe("curate-digest");
    expect(outcome.continueExecution).toBe(false);
    expect(outcome.costUsd).toBeGreaterThan(0);

    const result = getResult();
    expect(result.digest).toHaveLength(2);
    expect(result.digest[0].title).toBe("New Jazz Playlist");
    expect(result.digest[0].priority).toBe("high");
  });

  it("step 1: returns empty digest on malformed response (P11)", async () => {
    const orch = makeMockOrchestrator("not json");
    const { workflow, getResult } = createCuratorWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().digest).toHaveLength(0);
  });

  it("step 1: filters out invalid items", async () => {
    const llmResponse = JSON.stringify([
      { title: "Valid Item", summary: "Has all fields", priority: "high" },
      { title: "Missing priority", summary: "No priority field" },
      { title: "Bad priority", summary: "Invalid value", priority: "urgent" },
    ]);
    const orch = makeMockOrchestrator(llmResponse);
    const { workflow, getResult } = createCuratorWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().digest).toHaveLength(1);
    expect(getResult().digest[0].title).toBe("Valid Item");
  });

  it("step 1: caps digest at 5 items", async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `Item ${i}`,
      summary: `Summary ${i}`,
      priority: "medium",
    }));
    const orch = makeMockOrchestrator(JSON.stringify(items));
    const { workflow, getResult } = createCuratorWorkflow(INPUT, orch);

    await workflow(makeContext({ stepCount: 1 }));

    expect(getResult().digest).toHaveLength(5);
  });

  it("default step returns done", async () => {
    const orch = makeMockOrchestrator("[]");
    const { workflow } = createCuratorWorkflow(INPUT, orch);

    const outcome = await workflow(makeContext({ stepCount: 99 }));

    expect(outcome.action).toBe("done");
    expect(outcome.continueExecution).toBe(false);
  });
});
