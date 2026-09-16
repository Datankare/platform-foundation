/**
 * adaptive-registry.test.ts — ADR-036 D3 registry + mandatory-fallback guard.
 */
import type { AdaptiveBehavior, AnyAdaptiveBehavior } from "@/platform/adaptive";
import {
  registerAdaptiveBehavior,
  getAdaptiveBehavior,
  hasAdaptiveBehavior,
  listAdaptiveBehaviors,
  resetAdaptiveBehaviors,
} from "@/platform/adaptive";
import type { AIRequest } from "@/platform/ai/types";

const behavior = (
  name: string
): AdaptiveBehavior<{ n: number }, { doubled: number }> => ({
  name,
  agentId: `${name}-agent`,
  build: (input): AIRequest => ({
    tier: "fast",
    messages: [],
    maxTokens: 64,
    system: `${input.n}`,
  }),
  parse: (raw) => ({ doubled: Number(raw) }),
  schema: {
    type: "object",
    properties: { doubled: { type: "number" } },
    required: ["doubled"],
  },
  fallback: (input) => ({ doubled: input.n * 2 }),
  summarize: (d) => `doubled=${d.doubled}`,
});

describe("adaptive registry (ADR-036 D3)", () => {
  beforeEach(() => resetAdaptiveBehaviors());

  it("registers and retrieves a behavior", () => {
    registerAdaptiveBehavior(behavior("difficulty"));
    expect(hasAdaptiveBehavior("difficulty")).toBe(true);
    expect(getAdaptiveBehavior("difficulty")?.agentId).toBe("difficulty-agent");
    expect(listAdaptiveBehaviors()).toEqual(["difficulty"]);
  });

  it("REFUSES a behavior without a deterministic fallback (D3)", () => {
    const noFallback = {
      ...behavior("bad"),
      fallback: undefined,
    } as unknown as AnyAdaptiveBehavior;
    expect(() => registerAdaptiveBehavior(noFallback)).toThrow(/deterministic fallback/);
    expect(hasAdaptiveBehavior("bad")).toBe(false);
  });

  it("refuses a duplicate registration", () => {
    registerAdaptiveBehavior(behavior("dup"));
    expect(() => registerAdaptiveBehavior(behavior("dup"))).toThrow(/already registered/);
  });

  it("returns undefined / false for an unregistered behavior", () => {
    expect(getAdaptiveBehavior("nope")).toBeUndefined();
    expect(hasAdaptiveBehavior("nope")).toBe(false);
    expect(listAdaptiveBehaviors()).toEqual([]);
  });
});
