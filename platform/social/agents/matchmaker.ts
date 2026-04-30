/**
 * platform/social/agents/matchmaker.ts — Group recommendation agent
 *
 * Recommends groups for users via LLM analysis of interests
 * and available groups. Falls back to empty recommendations
 * if no candidate groups exist (P11).
 *
 * P2:  Multi-step: gather context → LLM recommend
 * P7:  Orchestrator-backed (swappable provider)
 * P11: No candidates → graceful empty result
 * P12: Cost tracked per step
 * P17: Both steps are cognition (advisory, not commitment)
 *
 * @module platform/social/agents
 */

import type { WorkflowFn, StepOutcome, WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";
import {
  MATCHMAKER_V1,
  buildMatchmakerPrompt,
  parseMatchmakerResponse,
} from "@/prompts/social/matchmaker-v1";
import type {
  MatchmakerInput,
  MatchmakerRecommendation,
} from "@/prompts/social/matchmaker-v1";
import { estimateCost } from "@/platform/ai/instrumentation";

/** Result of the matchmaker workflow, available after execution */
export interface MatchmakerResult {
  readonly recommendations: readonly MatchmakerRecommendation[];
}

/**
 * Create a matchmaker workflow function.
 *
 * Step 0 (cognition): Validate candidate groups exist.
 * Step 1 (cognition): LLM ranks and recommends groups.
 */
/**
 * Create a matchmaker workflow function.
 *
 * Returns { workflow, getResult } — workflow is the step function passed to
 * executeAgent(); getResult() returns the accumulated recommendations after
 * execution completes (closure-based result extraction).
 *
 * The 2-step structure (gather context, then LLM) is intentionally simple.
 * As matchmaker gains multi-step reasoning (re-rank after feedback, P14)
 * and memory (previous recommendations, P16), steps will diverge from
 * other social agents. Do not extract a shared factory.
 *
 * Step 0 (cognition): Validate candidate groups exist.
 * Step 1 (cognition): LLM ranks and recommends groups.
 */
export function createMatchmakerWorkflow(
  input: MatchmakerInput,
  orchestrator: Orchestrator
): { workflow: WorkflowFn; getResult: () => MatchmakerResult } {
  let recommendations: readonly MatchmakerRecommendation[] = [];

  const workflow: WorkflowFn = async (context: WorkflowContext): Promise<StepOutcome> => {
    switch (context.stepCount) {
      case 0: {
        const groupCount = input.candidateGroups.length;
        return {
          action: "gather-candidates",
          boundary: "cognition",
          input: { userId: input.userId, interestCount: input.userInterests.length },
          output: { candidateCount: groupCount },
          costUsd: 0,
          continueExecution: groupCount > 0,
        };
      }
      case 1: {
        const prompt = buildMatchmakerPrompt(input);
        const response: AIResponse = await orchestrator.complete(
          {
            tier: MATCHMAKER_V1.tier,
            messages: [{ role: "user", content: prompt }],
            maxTokens: MATCHMAKER_V1.maxTokens,
            temperature: MATCHMAKER_V1.temperature,
          },
          { useCase: MATCHMAKER_V1.name, requestId: context.trajectoryId }
        );

        const raw =
          response.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("") || "[]";

        recommendations = parseMatchmakerResponse(raw);
        const cost = estimateCost(
          MATCHMAKER_V1.tier,
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        return {
          action: "recommend-groups",
          boundary: "cognition",
          input: { candidateCount: input.candidateGroups.length },
          output: { recommendationCount: recommendations.length },
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

  return { workflow, getResult: () => ({ recommendations }) };
}
