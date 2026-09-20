/**
 * loop.test.ts — ADR-037 D2/D3/D4: the generation loop runs traced, is fail-closed, and screens
 * generated content before it can surface. Every fallback trigger (orchestrator error, parse
 * failure, schema-invalid, run-incomplete, screening block/escalate/error) yields the static
 * template; allow/warn content surfaces.
 */
jest.mock("@/platform/ai");
jest.mock("@/platform/moderation/middleware", () => ({ screenContent: jest.fn() }));

import { getOrchestrator } from "@/platform/ai";
import { screenContent } from "@/platform/moderation/middleware";
import { registerAgent } from "@/platform/agents/registry";
import { generateContent } from "@/platform/content/loop";
import type { ContentType } from "@/platform/content";
import type { AIRequest } from "@/platform/ai/types";

const AGENT = "content-test-host";

interface In {
  readonly topic: string;
}
interface Out {
  readonly headline: string;
}

const ct: ContentType<In, Out> = {
  name: "test-digest",
  agentId: AGENT,
  build: (i): AIRequest => ({
    tier: "fast",
    messages: [{ role: "user", content: i.topic }],
    maxTokens: 64,
  }),
  parse: (raw) => JSON.parse(raw) as Out,
  schema: {
    type: "object",
    properties: { headline: { type: "string" } },
    required: ["headline"],
    additionalProperties: false,
  },
  renderFallback: () => ({ headline: "Nothing to show right now." }),
  toScreenText: (c) => c.headline,
};

const complete = jest.fn();
const screen = screenContent as jest.Mock;
const scope = { type: "group" as const, id: "g1" };
const textResponse = (t: string) => ({
  content: [{ type: "text", text: t }],
  model: "test",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});
const FALLBACK = { headline: "Nothing to show right now." };

beforeAll(() => {
  registerAgent({
    id: AGENT,
    name: AGENT,
    description: "content loop test host",
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
  screen.mockReset();
  (getOrchestrator as jest.Mock).mockReturnValue({ complete });
});

describe("content generation loop (ADR-037 D2/D3/D4)", () => {
  it("surfaces screened generated content on the happy path", async () => {
    complete.mockResolvedValue(textResponse('{"headline":"Ship it"}'));
    screen.mockResolvedValue({ action: "allow" });

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.content).toEqual({ headline: "Ship it" });
    expect(r.usedFallback).toBe(false);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.trajectoryId).toBeTruthy();
    expect(screen).toHaveBeenCalledWith(
      "Ship it",
      expect.objectContaining({ direction: "output" })
    );
  });

  it("surfaces warn content (allowed with a flag)", async () => {
    complete.mockResolvedValue(textResponse('{"headline":"edgy"}'));
    screen.mockResolvedValue({ action: "warn" });

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.usedFallback).toBe(false);
    expect(r.content).toEqual({ headline: "edgy" });
  });

  it("falls back on an orchestrator error and never screens", async () => {
    complete.mockRejectedValue(new Error("provider down"));

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.usedFallback).toBe(true);
    expect(r.fallbackReason).toBe("orchestrator-error");
    expect(r.content).toEqual(FALLBACK);
    expect(screen).not.toHaveBeenCalled();
  });

  it("falls back on a parse failure", async () => {
    complete.mockResolvedValue(textResponse("not json"));

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.fallbackReason).toBe("parse-error");
    expect(r.content).toEqual(FALLBACK);
  });

  it("falls back on schema-invalid output", async () => {
    complete.mockResolvedValue(textResponse('{"wrong":1}'));

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.fallbackReason).toBe("schema-invalid");
  });

  it("falls back when the run never completes (host unregistered)", async () => {
    complete.mockResolvedValue(textResponse('{"headline":"x"}'));

    const r = await generateContent(
      { ...ct, agentId: "unregistered-host" },
      { topic: "x" },
      scope
    );

    expect(r.fallbackReason).toBe("run-incomplete");
    expect(r.content).toEqual(FALLBACK);
  });

  it("withholds blocked content and falls back (D4)", async () => {
    complete.mockResolvedValue(textResponse('{"headline":"bad"}'));
    screen.mockResolvedValue({ action: "block" });

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.usedFallback).toBe(true);
    expect(r.fallbackReason).toBe("screening-blocked");
    expect(r.content).toEqual(FALLBACK);
  });

  it("withholds escalated content and falls back (D4)", async () => {
    complete.mockResolvedValue(textResponse('{"headline":"maybe"}'));
    screen.mockResolvedValue({ action: "escalate" });

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.fallbackReason).toBe("screening-blocked");
  });

  it("fails closed when screening itself throws", async () => {
    complete.mockResolvedValue(textResponse('{"headline":"x"}'));
    screen.mockRejectedValue(new Error("guardian down"));

    const r = await generateContent(ct, { topic: "x" }, scope);

    expect(r.fallbackReason).toBe("screening-blocked");
    expect(r.content).toEqual(FALLBACK);
  });
});
