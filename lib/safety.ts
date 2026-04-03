/**
 * lib/safety.ts — Content safety check
 *
 * ADR-015: Uses the orchestration layer — no raw fetch/SDK calls.
 * ADR-016: Structured classification (categories, confidence, severity).
 *
 * Phase 2 upgrade: binary safe/unsafe → structured ClassifierOutput.
 * Backwards-compatible: checkSafety() still returns SafetyResult.
 * New: classifyContent() returns full ClassifierOutput.
 */

import { SafetyResult } from "@/types";
import { getOrchestrator } from "@/platform/ai";
import { getPromptConfig } from "@/prompts";
import {
  buildSafetyPrompt,
  parseClassifierResponse,
  ClassifierOutput,
} from "@/prompts/safety/classify-v1";
import { logger, generateRequestId } from "@/lib/logger";

/**
 * Full structured classification — returns categories, confidence, severity.
 * Use this for audit trail and tiered enforcement (ADR-016).
 */
export async function classifyContent(
  text: string,
  requestId?: string
): Promise<ClassifierOutput> {
  const reqId = requestId ?? generateRequestId();
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
        requestId: reqId,
      }
    );

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      // Fail closed — no text response
      return {
        safe: false,
        categories: [],
        confidence: 0.5,
        severity: "medium",
        reason: "Safety classifier returned unexpected response type.",
      };
    }

    return parseClassifierResponse(textBlock.text);
  } catch (err) {
    // Fail closed — any error means unsafe
    // OWASP A09: structured logging — never log user content
    logger.error("Safety classification error — fail closed", {
      requestId: reqId,
      route: "lib/safety",
      error: err instanceof Error ? err.message : "Unknown",
    });
    return {
      safe: false,
      categories: [],
      confidence: 0.5,
      severity: "medium",
      reason: "Content could not be verified as safe.",
    };
  }
}

/**
 * Backwards-compatible safety check — returns simple SafetyResult.
 * Delegates to classifyContent() internally.
 */
export async function checkSafety(
  text: string,
  requestId?: string
): Promise<SafetyResult> {
  const result = await classifyContent(text, requestId);
  return {
    safe: result.safe,
    reason: result.reason,
  };
}
