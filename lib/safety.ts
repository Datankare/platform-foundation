/**
 * lib/safety.ts — Content safety check (backwards-compatible facade)
 *
 * ADR-016: Multi-layer defense via platform/moderation middleware.
 * ADR-017: Input AND output screening through same pipeline.
 *
 * This file is a thin wrapper for backwards compatibility.
 * New code should use `screenContent` from `@/platform/moderation` directly.
 */

import { SafetyResult } from "@/types";
import { screenContent } from "@/platform/moderation";
import type { ClassifierOutput } from "@/prompts/safety/classify-v1";
import { generateRequestId } from "@/lib/logger";

/**
 * Full structured classification — returns categories, confidence, severity.
 * Delegates to the moderation middleware pipeline (blocklist + classifier + audit).
 */
export async function classifyContent(
  text: string,
  requestId?: string
): Promise<ClassifierOutput> {
  const reqId = requestId ?? generateRequestId();

  const result = await screenContent(text, {
    direction: "input",
    requestId: reqId,
  });

  // If classifier was invoked, return its output
  if (result.classifierOutput) {
    return result.classifierOutput;
  }

  // Blocklist-only result (no classifier invoked) — synthesize ClassifierOutput
  return {
    safe: result.action === "allow",
    categories: [],
    confidence: 1.0,
    severity: result.action === "block" ? "critical" : "low",
    reason:
      result.action === "block"
        ? `Blocked by content filter: ${result.blocklistMatches.join(", ")}`
        : undefined,
  };
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
