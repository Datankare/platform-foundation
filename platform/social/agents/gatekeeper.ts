/**
 * platform/social/agents/gatekeeper.ts — Join request evaluation agent
 *
 * Evaluates join requests and produces recommendations for admin review.
 * Never auto-approves — always produces advisory output (P10).
 *
 * P2:  Multi-step: gather context → LLM evaluate
 * P10: Output is recommendation, not auto-decision
 * P11: Parse failure → "review" recommendation (fail-safe)
 * P17: Both steps are cognition (advisory)
 *
 * @module platform/social/agents
 */

import type { WorkflowFn, StepOutcome, WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";
import {
  GATEKEEPER_V1,
  buildGatekeeperPrompt,
  parseGatekeeperResponse,
} from "@/prompts/social/gatekeeper-v1";
import type {
  GatekeeperInput,
  GatekeeperEvaluation,
} from "@/prompts/social/gatekeeper-v1";
import { estimateCost } from "@/platform/ai/instrumentation";

/** Result of the gatekeeper workflow */
export interface GatekeeperResult {
  readonly evaluation: GatekeeperEvaluation;
}

/**
 * Create a gatekeeper workflow function.
 *
 * Step 0 (cognition): Validate input context.
 * Step 1 (cognition): LLM evaluates fit.
 */
/**
 * Create a gatekeeper workflow function.
 *
 * Returns { workflow, getResult } — workflow is the step function passed to
 * executeAgent(); getResult() returns the evaluation after execution
 * completes (closure-based result extraction).
 *
 * The 2-step structure is intentionally simple. As gatekeeper gains
 * multi-signal evaluation (group history, applicant reputation, P8/P16),
 * steps will diverge from other social agents.
 *
 * Step 0 (cognition): Validate input context.
 * Step 1 (cognition): LLM evaluates fit.
 */
export function createGatekeeperWorkflow(
  input: GatekeeperInput,
  orchestrator: Orchestrator
): { workflow: WorkflowFn; getResult: () => GatekeeperResult } {
  let evaluation: GatekeeperEvaluation = {
    decision: "review",
    confidence: 0,
    reason: "Not yet evaluated",
  };

  const workflow: WorkflowFn = async (context: WorkflowContext): Promise<StepOutcome> => {
    switch (context.stepCount) {
      case 0: {
        return {
          action: "gather-context",
          boundary: "cognition",
          input: {
            groupName: input.groupName,
            applicantId: input.applicantId,
          },
          output: { contextReady: true },
          costUsd: 0,
          continueExecution: true,
        };
      }
      case 1: {
        const prompt = buildGatekeeperPrompt(input);
        const response: AIResponse = await orchestrator.complete(
          {
            tier: GATEKEEPER_V1.tier,
            messages: [{ role: "user", content: prompt }],
            maxTokens: GATEKEEPER_V1.maxTokens,
            temperature: GATEKEEPER_V1.temperature,
          },
          { useCase: GATEKEEPER_V1.name, requestId: context.trajectoryId }
        );

        const raw =
          response.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("") || "{}";

        evaluation = parseGatekeeperResponse(raw);
        const cost = estimateCost(
          GATEKEEPER_V1.tier,
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        return {
          action: "evaluate-fit",
          boundary: "cognition",
          input: { applicantId: input.applicantId },
          output: {
            decision: evaluation.decision,
            confidence: evaluation.confidence,
          },
          costUsd: cost,
          continueExecution: false,
        };
      }
      default:
        return {
          action: "done",
          boundary: "cognition",
          input: {},
          output: {},
          costUsd: 0,
          continueExecution: false,
        };
    }
  };

  return { workflow, getResult: () => ({ evaluation }) };
}
