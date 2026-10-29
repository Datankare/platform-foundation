/**
 * platform/moderation/classifier.ts — LLM-based content classifier
 *
 * ADR-016: Layer 2 of multi-layer defense.
 * ADR-015: Uses orchestration layer — no raw API calls.
 *
 * Wraps the safety prompt and orchestrator into a clean interface.
 * Returns structured ClassifierOutput (categories, confidence, severity).
 */

import { getOrchestrator } from "@/platform/ai";
import { getPromptConfig } from "@/prompts";
import { buildSafetyPrompt, parseClassifierResponse } from "@/prompts/safety/classify-v1";
import type { ClassifierOutput } from "@/prompts/safety/classify-v1";
import { logger } from "@/lib/logger";
import { estimateCost } from "@/platform/ai/instrumentation";
import { isAIRefusalError, refusalUsage } from "@/platform/ai/provider";

/**
 * The classifier's output with what it cost (audit D-20: every screening recorded a cost of 0),
 * and whether the classifier could not judge the text at all (audit RR-8).
 */
export type ClassifierResult = ClassifierOutput & {
  /** Estimated cost of the classifier call, in USD (0 when no call was made). */
  readonly costUsd: number;
  /** True when the classifier was unavailable or unreadable: the text was not judged. */
  readonly unavailable?: true;
  /**
   * True when the model declined to classify the text (stop_reason "refusal"): the guardian
   * withholds it for human review at every rating level, whatever the thresholds and context
   * reductions — never allowed, no strike unless a reviewer decides it was a violation (TASK-186).
   */
  readonly declined?: true;
};

/**
 * Run the LLM classifier on the given text.
 * Returns structured output with categories, confidence, severity.
 *
 * Fails closed — any error returns unsafe with low confidence.
 */
export async function classify(
  text: string,
  requestId: string
): Promise<ClassifierResult> {
  const config = getPromptConfig("safety-classify");

  try {
    const response = await getOrchestrator().complete(
      {
        tier: config.tier,
        messages: [{ role: "user", content: buildSafetyPrompt(text) }],
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      },
      {
        useCase: config.name,
        requestId,
      }
    );

    const costUsd = estimateCost(config.tier, response.usage);
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return failClosedResult("Classifier returned unexpected response type", costUsd);
    }

    return { ...parseClassifierResponse(textBlock.text), costUsd };
  } catch (err) {
    // The model declined to classify the text: a rejection, not an outage. Still billed.
    if (isAIRefusalError(err)) {
      logger.warn("Classifier declined the text — withheld", {
        requestId,
        route: "platform/moderation/classifier",
      });
      return {
        safe: false,
        categories: [],
        confidence: 1,
        severity: "critical",
        reason: "declined",
        costUsd: estimateCost(config.tier, refusalUsage(err)),
        declined: true,
      };
    }
    // Fail closed — any error means unsafe
    logger.error("Classifier error — fail closed", {
      requestId,
      route: "platform/moderation/classifier",
      error: err instanceof Error ? err.message : "Unknown",
    });
    return failClosedResult("Classifier unavailable", 0);
  }
}

function failClosedResult(reason: string, costUsd: number): ClassifierResult {
  return {
    safe: false,
    categories: [],
    confidence: 0.5,
    severity: "medium",
    reason,
    costUsd,
    unjudged: true,
    unavailable: true,
  };
}
