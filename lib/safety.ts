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
import { shown } from "@/platform/errors/shown-text";

/**
 * The classifier's output, and — when the pipeline did not let the input through — what it
 * decided (TASK-211, N-119; SafetyResult["decision"]). A route answers it with
 * lib/screening-refusal.ts.
 */
export type ScreenedInput = ClassifierOutput & {
  readonly decision?: SafetyResult["decision"];
};

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
): Promise<ScreenedInput> {
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
  // TASK-211 (N-119): not safe is one of three things, and the caller answers each differently —
  // nothing judged (an outage: withheld, never queued), held for a moderator, or blocked.
  const decision: SafetyResult["decision"] = passes
    ? undefined
    : result.screeningUnavailable
      ? "unjudged"
      : result.action === "escalate"
        ? "escalate"
        : "block";
  if (result.classifierOutput) {
    return passes
      ? result.classifierOutput
      : {
          ...result.classifierOutput,
          safe: false,
          // The platform's note (a key, TASK-209): the model's own words stay in rawReason.
          note:
            result.classifierOutput.note ??
            shown("screens.moderation.classifier.pipeline_action", {
              action: result.action,
            }),
          decision,
        };
  }

  // Blocklist-only result (no classifier invoked) — synthesize ClassifierOutput
  return {
    safe: passes,
    categories: [],
    confidence: 1.0,
    severity: result.action === "block" ? "critical" : "low",
    ...(result.action === "block"
      ? {
          note: shown("screens.moderation.classifier.filter_block", {
            matches: result.blocklistMatches.join(", "),
          }),
        }
      : {}),
    ...(passes ? {} : { decision }),
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
  const decision = result.decision;
  return {
    safe: result.safe,
    ...(result.note ? { reasons: [result.note] } : {}),
    ...(result.rawReason ? { rawReason: result.rawReason } : {}),
    ...(!result.safe && decision ? { decision } : {}),
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
    : {
        safe: false,
        reasons: typeof result.reasoning === "string" ? [] : result.reasoning,
      };
}
