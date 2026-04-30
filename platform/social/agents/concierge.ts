/**
 * platform/social/agents/concierge.ts — Onboarding agent
 *
 * Generates personalized onboarding ActionItem[] for new members.
 * Uses the same UI contract as the input agent layer.
 *
 * P2:  Multi-step: gather context → LLM generate actions
 * P6:  Output matches ActionItem schema
 * P10: Actions are suggestions — user decides
 * P11: Parse failure → default welcome action
 *
 * @module platform/social/agents
 */

import type { WorkflowFn, StepOutcome, WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";
import {
  CONCIERGE_V1,
  buildConciergePrompt,
  parseConciergeResponse,
} from "@/prompts/social/concierge-v1";
import type { ConciergeInput, OnboardingAction } from "@/prompts/social/concierge-v1";
import { estimateCost } from "@/platform/ai/instrumentation";

/** Result of the concierge workflow */
export interface ConciergeResult {
  readonly actions: readonly OnboardingAction[];
}

/**
 * Create a concierge workflow function.
 *
 * Step 0 (cognition): Validate group context.
 * Step 1 (cognition): LLM generates onboarding steps.
 */
/**
 * Create a concierge workflow function.
 *
 * Returns { workflow, getResult } — workflow is the step function passed to
 * executeAgent(); getResult() returns the onboarding actions after execution
 * completes (closure-based result extraction).
 *
 * The 2-step structure is intentionally simple. As concierge gains
 * persona coaching (P16 memory) and adaptive onboarding (track which
 * steps the user completed), steps will diverge.
 *
 * Step 0 (cognition): Validate group context.
 * Step 1 (cognition): LLM generates onboarding steps.
 */
export function createConciergeWorkflow(
  input: ConciergeInput,
  orchestrator: Orchestrator
): { workflow: WorkflowFn; getResult: () => ConciergeResult } {
  let actions: readonly OnboardingAction[] = [];

  const workflow: WorkflowFn = async (context: WorkflowContext): Promise<StepOutcome> => {
    switch (context.stepCount) {
      case 0: {
        return {
          action: "gather-context",
          boundary: "cognition",
          input: {
            groupName: input.groupName,
            memberName: input.memberName,
          },
          output: { contextReady: true },
          costUsd: 0,
          continueExecution: true,
        };
      }
      case 1: {
        const prompt = buildConciergePrompt(input);
        const response: AIResponse = await orchestrator.complete(
          {
            tier: CONCIERGE_V1.tier,
            messages: [{ role: "user", content: prompt }],
            maxTokens: CONCIERGE_V1.maxTokens,
            temperature: CONCIERGE_V1.temperature,
          },
          { useCase: CONCIERGE_V1.name, requestId: context.trajectoryId }
        );

        const raw =
          response.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("") || "[]";

        actions = parseConciergeResponse(raw);
        const cost = estimateCost(
          CONCIERGE_V1.tier,
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        return {
          action: "generate-onboarding",
          boundary: "cognition",
          input: { groupName: input.groupName },
          output: { actionCount: actions.length },
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

  return { workflow, getResult: () => ({ actions }) };
}
