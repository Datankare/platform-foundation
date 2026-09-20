/**
 * __tests__/contract/adaptive-behavior-contract.ts — ADR-036 §6 (L21) conformance kit.
 *
 * The portable kit that proves an AdaptiveBehavior satisfies the ADR-036 contract: fail-closed on
 * every runtime failure, governed effects, session-scoped memory, and an eval-gated prompt. A
 * consumer (Playform, or any app on this platform) runs it against its own behavior to learn
 * whether that behavior behaves as the ADR requires; this repo's own invocation is
 * __tests__/adaptive-behavior-conformance.test.ts.
 *
 * The invoking file MUST, before calling this kit:
 *   - jest.mock("@/platform/ai") with getOrchestrator: jest.fn()   (partial mock)
 *   - jest.mock("@/platform/action-pipeline") with executeActionPipeline: jest.fn()
 *   - register the behavior and its host agent (so runAdaptive resolves the host)
 *
 * A conformant behavior's parser is fail-closed (never throws, never emits an invalid decision),
 * so the parse-error and schema-invalid branches cannot be reached through the real parser. The kit
 * injects those two failures at the seam (a throwing / schema-violating parse on a copy of the
 * behavior) to prove the framework returns THIS behavior's fallback for each. Orchestrator error,
 * open breaker, and run-incomplete are driven through the real path.
 */
import { getOrchestrator } from "@/platform/ai";
import { executeActionPipeline } from "@/platform/action-pipeline";
import {
  runAdaptive,
  routeAdaptiveEffect,
  registerAdaptiveBehavior,
  readAdaptiveMemory,
  resetAdaptiveMemory,
  type AdaptiveBehavior,
  type AdaptiveMemory,
  type AdaptiveEffectRequest,
} from "@/platform/adaptive";
import { EVAL_SUITES } from "@/prompts/evals";

export interface AdaptiveBehaviorContractSpec<TInput, TDecision> {
  /** The registered behavior under test. */
  readonly behavior: AdaptiveBehavior<TInput, TDecision>;
  /** A valid input the behavior's build() accepts. */
  readonly sampleInput: TInput;
}

const EMPTY_MEMORY: AdaptiveMemory = { recent: [] };

const textResponse = (text: string) => ({
  content: [{ type: "text", text }],
  model: "contract",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});

/** Run the ADR-036 L21 contract against one behavior. */
export function runAdaptiveBehaviorContract<TInput, TDecision>(
  spec: AdaptiveBehaviorContractSpec<TInput, TDecision>
): void {
  const { behavior, sampleInput } = spec;
  const orch = getOrchestrator as jest.Mock;
  const pipe = executeActionPipeline as jest.Mock;
  const scope = { type: "group" as const, id: "contract-session" };
  const expectedFallback = () => behavior.fallback(sampleInput, EMPTY_MEMORY);

  describe(`adaptive behavior contract — ${behavior.name} (ADR-036 L21)`, () => {
    beforeEach(() => {
      resetAdaptiveMemory();
      orch.mockReset();
      pipe.mockReset();
    });

    it("registration is rejected without a deterministic fallback (D3)", () => {
      const noFallback = {
        ...behavior,
        name: `${behavior.name}__contract-no-fallback`,
        fallback: undefined as unknown as AdaptiveBehavior<TInput, TDecision>["fallback"],
      };
      expect(() => registerAdaptiveBehavior(noFallback)).toThrow(/fallback/i);
    });

    it("an orchestrator error yields the deterministic fallback", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockRejectedValue(new Error("orchestrator unavailable")),
      });
      const r = await runAdaptive(behavior, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("orchestrator-error");
      expect(r.decision).toEqual(expectedFallback());
    });

    it("an open circuit breaker yields the deterministic fallback", async () => {
      // ADR-015: the orchestrator throws when the breaker is open; runAdaptive treats it as an
      // orchestration failure (same reason), so a dead provider can never skip the fallback.
      orch.mockReturnValue({
        complete: jest
          .fn()
          .mockRejectedValue(
            new Error("Circuit breaker is open — AI provider is unavailable")
          ),
      });
      const r = await runAdaptive(behavior, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("orchestrator-error");
      expect(r.decision).toEqual(expectedFallback());
    });

    it("a parse failure yields the deterministic fallback", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse("anything")),
      });
      const throwing: AdaptiveBehavior<TInput, TDecision> = {
        ...behavior,
        parse: () => {
          throw new Error("parse boom");
        },
      };
      const r = await runAdaptive(throwing, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("parse-error");
      expect(r.decision).toEqual(expectedFallback());
    });

    it("a schema-invalid decision yields the deterministic fallback", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse("anything")),
      });
      const invalid: AdaptiveBehavior<TInput, TDecision> = {
        ...behavior,
        // Returns a value the behavior's own schema rejects (null is not the object the schema
        // requires), exercising the schema-invalid branch rather than a parser throw.
        parse: () => null as unknown as TDecision,
      };
      const r = await runAdaptive(invalid, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("schema-invalid");
      expect(r.decision).toEqual(expectedFallback());
    });

    it("a run that never completes yields the deterministic fallback", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse("anything")),
      });
      const unhosted: AdaptiveBehavior<TInput, TDecision> = {
        ...behavior,
        agentId: "contract-unregistered-host",
      };
      const r = await runAdaptive(unhosted, sampleInput, scope);
      expect(r.usedFallback).toBe(true);
      expect(r.fallbackReason).toBe("run-incomplete");
      expect(r.decision).toEqual(expectedFallback());
    });

    it("an effectful decision is observed on the action pipeline, never a direct commit (D4)", async () => {
      pipe.mockResolvedValue({
        conflict: false,
        tier: "durable",
        context: {},
        committed: {
          sessionId: "contract-session",
          state: { applied: true },
          version: 1,
        },
        step: null,
        trajectory: null,
      });
      const req: AdaptiveEffectRequest<{ applied: boolean }> = {
        spec: { type: `adaptive-${behavior.name}-effect`, effects: ["stateWrite"] },
        actor: { actorType: "agent", actorId: behavior.agentId, agentRole: "adaptive" },
        sessionId: "contract-session",
        label: `adaptive-${behavior.name}-effect`,
        cost: 0,
        stateStore: {} as never,
        trajectoryStore: {} as never,
        trajectoryId: "contract-t1",
        stepIndex: 0,
        expectedVersion: 0,
        computeNextState: () => ({ applied: true }),
      };
      const out = await routeAdaptiveEffect(req);
      // The pipeline is the only mutation path, and the boundary is forced — a caller cannot
      // commit directly or downgrade the gate.
      expect(pipe).toHaveBeenCalledTimes(1);
      expect(pipe).toHaveBeenCalledWith(
        expect.objectContaining({ boundary: "commitment" })
      );
      expect(out.status).toBe("applied");
    });

    it("within-session memory does not survive a session boundary (D5)", async () => {
      orch.mockReturnValue({
        complete: jest.fn().mockResolvedValue(textResponse("anything")),
      });
      const sessionA = { type: "group" as const, id: "contract-session-A" };
      const sessionB = { type: "group" as const, id: "contract-session-B" };

      await runAdaptive(behavior, sampleInput, sessionA);

      const memA = await readAdaptiveMemory(behavior.name, sessionA);
      const memB = await readAdaptiveMemory(behavior.name, sessionB);
      expect(memA.recent.length).toBeGreaterThan(0); // recorded within its own session
      expect(memB.recent).toHaveLength(0); // a different session inherits none of it
    });

    it("the behavior's prompt has an authored eval suite (ADR-038)", () => {
      expect(EVAL_SUITES.map((s) => s.prompt)).toContain(behavior.name);
    });
  });
}
