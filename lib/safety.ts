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

/** Who is being screened and the request it belongs to. */
export interface SafetyOptions {
  readonly requestId?: string;
  /** The signed-in user (users.id). Omit for guests, who have no account to hold a strike. */
  readonly userId?: string;
}

/**
 * Full structured classification — returns categories, confidence, severity.
 * Delegates to the moderation middleware pipeline (blocklist + classifier + audit).
 */
export async function classifyContent(
  text: string,
  options: SafetyOptions | string = {}
): Promise<ClassifierOutput> {
  const { requestId, userId } =
    typeof options === "string" ? { requestId: options } : options;
  const reqId = requestId ?? generateRequestId();

  // The signed-in user is passed on so a block records a strike and an escalation reaches the
  // review queue (audit X-5: no AI route passed it, so AI abuse never had a consequence).
  const result = await screenContent(text, {
    direction: "input",
    requestId: reqId,
    context: {
      contentType: "generation",
      contentRatingLevel: 1,
      ...(userId ? { userId } : {}),
    },
  });

  // The pipeline's final action decides, not the classifier's own verdict: the Guardian can
  // escalate or block after the classifier said "safe" (a failed later step fails closed).
  // Allow and warn let the content through; block and escalate do not (release review).
  const passes = result.action === "allow" || result.action === "warn";
  if (result.classifierOutput) {
    return passes
      ? result.classifierOutput
      : {
          ...result.classifierOutput,
          safe: false,
          reason: result.classifierOutput.reason ?? `Pipeline action: ${result.action}`,
        };
  }

  // Blocklist-only result (no classifier invoked) — synthesize ClassifierOutput
  return {
    safe: passes,
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
  options: SafetyOptions | string = {}
): Promise<SafetyResult> {
  const result = await classifyContent(text, options);
  return {
    safe: result.safe,
    reason: result.reason,
  };
}

/**
 * Screen model OUTPUT before it is shown (audit X-11). Safe only when the moderation pipeline
 * allows it outright: a block or an escalation withholds the text. No user is attributed — the
 * model wrote it — so an output block never strikes the account that asked.
 */
export async function checkOutputSafety(
  text: string,
  options: Pick<SafetyOptions, "requestId"> = {}
): Promise<SafetyResult> {
  const result = await screenContent(text, {
    direction: "output",
    requestId: options.requestId ?? generateRequestId(),
    context: { contentType: "ai-output", contentRatingLevel: 1 },
  });
  return result.action === "allow"
    ? { safe: true }
    : { safe: false, reason: result.reasoning };
}
