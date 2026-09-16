/**
 * platform/adaptive/loop.ts — the adaptive decision loop (ADR-036 D2/D3).
 *
 * Runs a behavior's decision inside executeAgent, so every adaptive decision is a traced
 * trajectory (D2). Fail-closed by construction (D3): an orchestrator error, an open circuit
 * breaker (the orchestrator throws when open, ADR-015), a parse failure, or schema-invalid output
 * each drive the behavior's deterministic fallback. A run that never completes (agent unavailable,
 * budget exhausted) falls back too, so a runtime failure can never yield a missing or unvalidated
 * decision.
 */
import { getOrchestrator } from "@/platform/ai";
import { executeAgent } from "@/platform/agents/runtime";
import type { WorkflowFn, StepOutcome, WorkflowContext } from "@/platform/agents/runtime";
import { isValidSchema } from "@/platform/agents/schema";
import type { AdaptiveBehavior, AdaptiveMemory } from "./types";

export interface AdaptiveScope {
  readonly type: "group" | "user" | "platform";
  readonly id: string | undefined;
}

export type FallbackReason =
  "orchestrator-error" | "parse-error" | "schema-invalid" | "run-incomplete";

export interface AdaptiveResult<TDecision> {
  readonly decision: TDecision;
  readonly usedFallback: boolean;
  readonly trajectoryId: string;
  /** Set iff the fallback fired; names which stage failed (observability). */
  readonly fallbackReason?: FallbackReason;
}

const EMPTY_MEMORY: AdaptiveMemory = { recent: [] };

export async function runAdaptive<TInput, TDecision>(
  behavior: AdaptiveBehavior<TInput, TDecision>,
  input: TInput,
  scope: AdaptiveScope,
  memory: AdaptiveMemory = EMPTY_MEMORY
): Promise<AdaptiveResult<TDecision>> {
  let decision: TDecision | undefined;
  let fallbackReason: FallbackReason | undefined;

  const workflow: WorkflowFn = async (ctx: WorkflowContext): Promise<StepOutcome> => {
    let text: string | undefined;

    // Stage 1 — orchestration. Any throw here is an orchestrator error or an open breaker.
    try {
      const request = behavior.build(input, memory);
      const response = await getOrchestrator().complete(request, {
        useCase: `adaptive:${behavior.name}`,
        requestId: ctx.trajectoryId,
      });
      const block = response.content.find((b) => b.type === "text");
      if (!block || block.type !== "text") {
        throw new Error("adaptive: no text block in response");
      }
      text = block.text;
    } catch {
      fallbackReason = "orchestrator-error";
    }

    // Stage 2 — parse. Stage 3 — schema validation.
    if (text !== undefined) {
      try {
        const parsed = behavior.parse(text);
        if (isValidSchema(behavior.schema, parsed)) {
          decision = parsed;
        } else {
          fallbackReason = "schema-invalid";
        }
      } catch {
        fallbackReason = "parse-error";
      }
    }

    if (decision === undefined) {
      decision = behavior.fallback(input, memory);
    }

    return {
      action: "adaptive-decide",
      boundary: "cognition",
      input: { behavior: behavior.name },
      output: {
        usedFallback: fallbackReason !== undefined,
        fallbackReason: fallbackReason ?? null,
      },
      costUsd: 0,
      continueExecution: false,
    };
  };

  const exec = await executeAgent(
    behavior.agentId,
    `adaptive-${behavior.name}`,
    scope.type,
    scope.id,
    workflow
  );

  // Post-run guard (D3): a run that did not complete may not have set a decision.
  if (!exec.success || decision === undefined) {
    fallbackReason = fallbackReason ?? "run-incomplete";
    decision = behavior.fallback(input, memory);
  }

  return {
    decision,
    usedFallback: fallbackReason !== undefined,
    trajectoryId: exec.trajectoryId,
    fallbackReason,
  };
}
