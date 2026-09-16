/**
 * adaptive-loop.test.ts — ADR-036 D2/D3: the adaptive loop runs traced and is fail-closed.
 * Every fallback trigger (orchestrator error, no-text, parse failure, schema-invalid,
 * run-incomplete) drives the deterministic fallback.
 */
jest.mock("@/platform/ai");
import { getOrchestrator } from "@/platform/ai";
import { registerAgent } from "@/platform/agents/registry";
import { runAdaptive } from "@/platform/adaptive/loop";
import type { AdaptiveBehavior } from "@/platform/adaptive";
import type { AIRequest } from "@/platform/ai/types";

const AGENT = "adaptive-test-agent";

interface In {
  readonly seed: number;
}
interface Out {
  readonly level: number;
}

const behavior: AdaptiveBehavior<In, Out> = {
  name: "difficulty",
  agentId: AGENT,
  build: (): AIRequest => ({
    tier: "fast",
    messages: [{ role: "user", content: "decide" }],
    maxTokens: 64,
  }),
  parse: (raw) => JSON.parse(raw) as Out,
  schema: {
    type: "object",
    properties: { level: { type: "number" } },
    required: ["level"],
    additionalProperties: false,
  },
  fallback: () => ({ level: 1 }),
  summarize: (d) => `level=${d.level}`,
};

const complete = jest.fn();
const textResponse = (text: string) => ({
  content: [{ type: "text", text }],
  model: "test",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});

beforeAll(() => {
  registerAgent({
    id: AGENT,
    name: AGENT,
    description: "adaptive loop test host",
    budgetConfig: {
      maxCostPerTrajectory: 1,
      maxCostPerDay: 100,
      maxStepsPerTrajectory: 4,
    },
    tools: [],
  });
});

beforeEach(() => {
  complete.mockReset();
  (getOrchestrator as jest.Mock).mockReturnValue({ complete });
});

const run = (b = behavior) => runAdaptive(b, { seed: 1 }, { type: "user", id: "u1" });

describe("adaptive loop (ADR-036 D2/D3)", () => {
  it("returns the model decision on the happy path (no fallback)", async () => {
    complete.mockResolvedValue(textResponse('{"level":5}'));
    const r = await run();
    expect(r.decision).toEqual({ level: 5 });
    expect(r.usedFallback).toBe(false);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.trajectoryId).toBeTruthy();
  });

  it("falls back on an orchestrator error / open breaker", async () => {
    complete.mockRejectedValue(new Error("circuit breaker open"));
    const r = await run();
    expect(r.decision).toEqual({ level: 1 });
    expect(r.usedFallback).toBe(true);
    expect(r.fallbackReason).toBe("orchestrator-error");
  });

  it("falls back when the response has no text block", async () => {
    complete.mockResolvedValue({
      content: [{ type: "tool_use", id: "t", name: "x", input: {} }],
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "tool_use",
    });
    const r = await run();
    expect(r.decision).toEqual({ level: 1 });
    expect(r.fallbackReason).toBe("orchestrator-error");
  });

  it("falls back on a parse failure", async () => {
    complete.mockResolvedValue(textResponse("not json at all"));
    const r = await run();
    expect(r.decision).toEqual({ level: 1 });
    expect(r.fallbackReason).toBe("parse-error");
  });

  it("falls back on schema-invalid output", async () => {
    complete.mockResolvedValue(textResponse('{"wrong":true}'));
    const r = await run();
    expect(r.decision).toEqual({ level: 1 });
    expect(r.fallbackReason).toBe("schema-invalid");
  });

  it("falls back when the run does not complete (unregistered agent)", async () => {
    complete.mockResolvedValue(textResponse('{"level":5}'));
    const r = await run({ ...behavior, agentId: "not-registered" });
    expect(r.decision).toEqual({ level: 1 });
    expect(r.usedFallback).toBe(true);
    expect(r.fallbackReason).toBe("run-incomplete");
  });
});
