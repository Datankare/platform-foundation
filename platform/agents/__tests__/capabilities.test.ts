/**
 * platform/agents/__tests__/capabilities.test.ts
 *
 * buildCapabilities is a pure function, so it is tested here directly rather than through
 * the route. The route (app/api/agent/capabilities/route.ts) only resolves live inputs
 * and serialises; its behaviour is these assertions plus getActiveProviders/listWorkflows.
 */

import { buildCapabilities } from "../capabilities";
import {
  listWorkflows,
  registerWorkflow,
  resetWorkflowRegistry,
  type WorkflowDefinition,
} from "../workflow-loop";
import type { Tool } from "@/platform/kernel";

function stepTool(id: string): Tool {
  return {
    id,
    name: id,
    description: id,
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    effects: [],
    execute: async () => ({}),
  };
}

const IDENTIFY: WorkflowDefinition = {
  goal: "identify-song",
  description: "hum or clip to a match",
  endpoint: "/api/agent/process-content",
  steps: [
    {
      tool: stepTool("identify"),
      intent: "inform",
      estimatedCostUSD: 0.002,
      input: (ctx) => ({ text: String(ctx.input.text ?? "") }),
    },
  ],
};

const FULL: WorkflowDefinition = {
  goal: "full-pipeline",
  description: "identify then speak",
  endpoint: "/api/agent/process-content",
  steps: [
    {
      tool: stepTool("identify"),
      intent: "inform",
      estimatedCostUSD: 0.002,
      input: (ctx) => ({ text: String(ctx.input.text ?? "") }),
    },
    {
      tool: stepTool("speak"),
      intent: "inform",
      estimatedCostUSD: 0.001,
      input: (ctx) => ({ text: String(ctx.outputs.at(-1)?.text ?? "") }),
    },
  ],
};

describe("buildCapabilities", () => {
  it("reports one goal capability per definition", () => {
    const caps = buildCapabilities([IDENTIFY, FULL], { songId: "mock" });
    expect(caps.goals.map((g) => g.goal)).toEqual(["identify-song", "full-pipeline"]);
  });

  it("sums step estimates into the goal estimate", () => {
    const caps = buildCapabilities([FULL], {});
    const full = caps.goals[0];
    expect(full.estimatedCostUSD).toBeCloseTo(0.003, 9);
    expect(full.steps).toHaveLength(2);
  });

  it("carries the provider selection names verbatim", () => {
    const caps = buildCapabilities([IDENTIFY], { songId: "acrcloud", tts: "google" });
    expect(caps.providerSelections).toEqual({ songId: "acrcloud", tts: "google" });
  });

  it("names the deferred D8 fields so their absence is by design (TASK-086)", () => {
    // The point of notReported: a discovering agent must be able to tell a field that is
    // absent-by-design from one absent-by-omission. Liveness is here on purpose.
    const caps = buildCapabilities([IDENTIFY], {});
    expect(caps.notReported).toContain("languages");
    expect(caps.notReported).toContain("providerLiveness");
  });

  it("reports step intent, not goal — the two vocabularies stay apart (ADR-030 D1)", () => {
    const caps = buildCapabilities([IDENTIFY], {});
    expect(caps.goals[0].steps[0].intent).toBe("inform");
    expect(caps.goals[0].steps[0]).not.toHaveProperty("goal");
  });

  it("handles an empty registry without inventing goals", () => {
    const caps = buildCapabilities([], {});
    expect(caps.goals).toEqual([]);
    // notReported is still present: the fields are deferred regardless of goal count.
    expect(caps.notReported.length).toBeGreaterThan(0);
  });
});

describe("listWorkflows", () => {
  beforeEach(() => {
    resetWorkflowRegistry();
  });

  it("returns the registered definitions, and buildCapabilities consumes them", () => {
    registerWorkflow(IDENTIFY);
    const caps = buildCapabilities(listWorkflows(), {});
    expect(caps.goals.map((g) => g.goal)).toEqual(["identify-song"]);
  });

  it("returns an empty list when nothing is registered", () => {
    expect(listWorkflows()).toEqual([]);
  });
});
