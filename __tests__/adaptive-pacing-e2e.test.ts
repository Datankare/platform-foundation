/**
 * adaptive-pacing-e2e.test.ts — ADR-036 step 4: the reference adaptive behavior, end-to-end
 * through the REAL boot path.
 *
 * Proves activation and the full consumer flow Playform will inherit:
 *   1. initProviders() (the server-boot path) registers the reference behavior AND the platform
 *      agents — making real the invariant jest.setup documents ("agents are registered at init in
 *      production");
 *   2. the registered behavior runs through runAdaptive: happy-path decision, within-session
 *      memory fed into the next prompt, and the runtime-failure fallbacks (orchestrator error,
 *      run-incomplete);
 *   3. the decision routes through the governed effect pipeline (routeAdaptiveEffect), boundary
 *      forced to "commitment", outcomes translated.
 *
 * Only the model call and the pipeline internals are stubbed — the mandatory seams in CI. The
 * orchestrator is partial-mocked (initAIProvider stays real so initProviders boots); the action
 * pipeline is partial-mocked exactly as adaptive-effect.test.ts does (its internals have their own
 * real suite). Parse/schema loop fallbacks are covered by adaptive-loop.test.ts — the reference
 * parser is total and fail-closed, so it cannot drive them here.
 */
jest.mock("@/platform/ai", () => ({
  ...jest.requireActual("@/platform/ai"),
  getOrchestrator: jest.fn(),
}));
jest.mock("@/platform/action-pipeline", () => ({
  ...jest.requireActual("@/platform/action-pipeline"),
  executeActionPipeline: jest.fn(),
}));

import { getOrchestrator } from "@/platform/ai";
import { executeActionPipeline, PipelineRejectedError } from "@/platform/action-pipeline";
import { initProviders, resetProviders } from "@/platform/providers";
import { listAgents, resetAgentRegistry } from "@/platform/agents";
import {
  runAdaptive,
  routeAdaptiveEffect,
  getAdaptiveBehavior,
  hasAdaptiveBehavior,
  resetAdaptiveBehaviors,
  resetAdaptiveMemory,
  type AdaptiveEffectRequest,
} from "@/platform/adaptive";
import { registerAdaptiveReference } from "@/platform/adaptive/bootstrap";
import { PACING_BEHAVIOR } from "@/platform/adaptive/behaviors/pacing";

const orch = getOrchestrator as jest.Mock;
const pipe = executeActionPipeline as jest.Mock;

const textResponse = (text: string) => ({
  content: [{ type: "text", text }],
  model: "test",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});
const withComplete = (complete: jest.Mock) => orch.mockReturnValue({ complete });

const groupScope = { type: "group" as const, id: "g1" };
const input = { scopeLabel: "g1", signal: "positive" };
const run = (behavior = PACING_BEHAVIOR) => runAdaptive(behavior, input, groupScope);

beforeEach(() => {
  // Isolate from the jest.setup mirror so each test proves the boot path itself.
  resetProviders();
  resetAgentRegistry();
  resetAdaptiveBehaviors();
  resetAdaptiveMemory();
  orch.mockReset();
  pipe.mockReset();
});

describe("adaptive-pacing reference — activation (ADR-036 step 4)", () => {
  it("initProviders() registers the reference behavior and its host agent at boot", () => {
    expect(hasAdaptiveBehavior("adaptive-pacing")).toBe(false);
    expect(listAgents()).not.toContain("adaptive-pacing-host");

    initProviders();

    expect(hasAdaptiveBehavior("adaptive-pacing")).toBe(true);
    expect(getAdaptiveBehavior("adaptive-pacing")).toBe(PACING_BEHAVIOR);
    expect(listAgents()).toContain("adaptive-pacing-host");
    // and the platform agents — the gap the jest.setup comment described, now real
    expect(listAgents()).toEqual(
      expect.arrayContaining(["guardian-social", "gatekeeper", "conductor"])
    );
  });

  it("registerAdaptiveReference is idempotent (safe on boot + test mirror)", () => {
    registerAdaptiveReference();
    expect(() => registerAdaptiveReference()).not.toThrow();
    expect(hasAdaptiveBehavior("adaptive-pacing")).toBe(true);
    expect(listAgents().filter((a) => a === "adaptive-pacing-host")).toHaveLength(1);
  });
});

describe("adaptive-pacing reference — decision loop (ADR-036 D2/D3/D5)", () => {
  it("returns the model decision on the happy path (no fallback)", async () => {
    initProviders();
    withComplete(
      jest
        .fn()
        .mockResolvedValue(
          textResponse(
            '{"decision":"accelerate","confidence":0.8,"rationale":"strong signal"}'
          )
        )
    );

    const r = await run();

    expect(r.decision).toMatchObject({ decision: "accelerate", confidence: 0.8 });
    expect(r.usedFallback).toBe(false);
    expect(r.fallbackReason).toBeUndefined();
    expect(r.trajectoryId).toBeTruthy();
  });

  it("feeds the prior decision back into the next prompt (within-session memory, D5)", async () => {
    initProviders();
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        textResponse('{"decision":"accelerate","confidence":0.9,"rationale":"go"}')
      )
      .mockResolvedValueOnce(
        textResponse('{"decision":"steady","confidence":0.5,"rationale":"hold"}')
      );
    withComplete(complete);

    await run();
    await run();

    const secondPrompt = complete.mock.calls[1][0].messages[0].content as string;
    expect(secondPrompt).toContain("pacing=accelerate");
  });

  it("falls back to steady on an orchestrator error / open breaker", async () => {
    initProviders();
    withComplete(jest.fn().mockRejectedValue(new Error("circuit breaker open")));

    const r = await run();

    expect(r.decision.decision).toBe("steady");
    expect(r.usedFallback).toBe(true);
    expect(r.fallbackReason).toBe("orchestrator-error");
  });

  it("falls back to steady when the run does not complete (host agent unregistered)", async () => {
    initProviders();
    withComplete(
      jest
        .fn()
        .mockResolvedValue(
          textResponse('{"decision":"accelerate","confidence":0.8,"rationale":"x"}')
        )
    );

    const r = await runAdaptive(
      { ...PACING_BEHAVIOR, agentId: "not-registered" },
      input,
      groupScope
    );

    expect(r.decision.decision).toBe("steady");
    expect(r.usedFallback).toBe(true);
    expect(r.fallbackReason).toBe("run-incomplete");
  });
});

describe("adaptive-pacing reference — governed effect routing (ADR-036 D4)", () => {
  const effectReq = (): AdaptiveEffectRequest<{ pace: string }> => ({
    spec: { type: "adaptive-set-pace", effects: ["stateWrite"] },
    actor: { actorType: "agent", actorId: "adaptive-pacing-host", agentRole: "adaptive" },
    sessionId: "g1",
    label: "adaptive-set-pace",
    cost: 0,
    stateStore: {} as never,
    trajectoryStore: {} as never,
    trajectoryId: "t1",
    stepIndex: 0,
    expectedVersion: 1,
    computeNextState: () => ({ pace: "accelerate" }),
  });

  it("routes an applied decision through the pipeline at boundary=commitment", async () => {
    initProviders();
    pipe.mockResolvedValue({
      conflict: false,
      tier: "durable",
      context: {},
      committed: { sessionId: "g1", state: { pace: "accelerate" }, version: 2 },
      step: null,
      trajectory: null,
    });

    const out = await routeAdaptiveEffect(effectReq());

    expect(out.status).toBe("applied");
    expect(out.committed?.version).toBe(2);
    expect(pipe).toHaveBeenCalledWith(
      expect.objectContaining({ boundary: "commitment" })
    );
  });

  it("translates a gated decision to held", async () => {
    initProviders();
    pipe.mockRejectedValue(
      new PipelineRejectedError("needs approval", "requires-approval")
    );

    const out = await routeAdaptiveEffect(effectReq());

    expect(out.status).toBe("held");
    expect(out.reason).toBe("requires-approval");
  });
});
