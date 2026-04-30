/**
 * platform/social/agents/curator.ts — Content digest agent
 *
 * Creates personalized content digests from group activity.
 * Runs on schedule and on-demand.
 *
 * P2:  Multi-step: gather activity → LLM curate
 * P6:  Structured digest output
 * P11: No activity → empty digest; parse failure → empty digest
 * P12: Fast tier for frequent generation
 *
 * @module platform/social/agents
 */

import type { WorkflowFn, StepOutcome, WorkflowContext } from "@/platform/agents/runtime";
import type { Orchestrator } from "@/platform/ai/orchestrator";
import type { AIResponse } from "@/platform/ai/types";
import {
  CURATOR_V1,
  buildCuratorPrompt,
  parseCuratorResponse,
} from "@/prompts/social/curator-v1";
import type { CuratorInput, DigestItem } from "@/prompts/social/curator-v1";
import { estimateCost } from "@/platform/ai/instrumentation";

/** Result of the curator workflow */
export interface CuratorResult {
  readonly digest: readonly DigestItem[];
}

/**
 * Create a curator workflow function.
 *
 * Step 0 (cognition): Validate activity exists.
 * Step 1 (cognition): LLM creates digest.
 */
/**
 * Create a curator workflow function.
 *
 * Returns { workflow, getResult } — workflow is the step function passed to
 * executeAgent(); getResult() returns the digest after execution completes
 * (closure-based result extraction).
 *
 * The 2-step structure is intentionally simple. As curator gains
 * personalization (user reading history, P16) and content scoring
 * (engagement signals from analyst, P14), steps will diverge.
 *
 * Step 0 (cognition): Validate activity exists.
 * Step 1 (cognition): LLM creates digest.
 */
export function createCuratorWorkflow(
  input: CuratorInput,
  orchestrator: Orchestrator
): { workflow: WorkflowFn; getResult: () => CuratorResult } {
  let digest: readonly DigestItem[] = [];

  const workflow: WorkflowFn = async (context: WorkflowContext): Promise<StepOutcome> => {
    switch (context.stepCount) {
      case 0: {
        const activityCount = input.recentActivity.length;
        return {
          action: "gather-activity",
          boundary: "cognition",
          input: { groupName: input.groupName, userId: input.userId },
          output: { activityCount },
          costUsd: 0,
          continueExecution: activityCount > 0,
        };
      }
      case 1: {
        const prompt = buildCuratorPrompt(input);
        const response: AIResponse = await orchestrator.complete(
          {
            tier: CURATOR_V1.tier,
            messages: [{ role: "user", content: prompt }],
            maxTokens: CURATOR_V1.maxTokens,
            temperature: CURATOR_V1.temperature,
          },
          { useCase: CURATOR_V1.name, requestId: context.trajectoryId }
        );

        const raw =
          response.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("") || "[]";

        digest = parseCuratorResponse(raw);
        const cost = estimateCost(
          CURATOR_V1.tier,
          response.usage.inputTokens,
          response.usage.outputTokens
        );

        return {
          action: "curate-digest",
          boundary: "cognition",
          input: { activityCount: input.recentActivity.length },
          output: { digestItemCount: digest.length },
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

  return { workflow, getResult: () => ({ digest }) };
}
