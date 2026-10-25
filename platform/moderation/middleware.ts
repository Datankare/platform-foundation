/**
 * platform/moderation/middleware.ts — Universal content safety middleware
 *
 * ADR-016: Applied at every input surface.
 * ADR-017 §1: Applied at every output surface.
 *
 * This is a thin wrapper around the Guardian agent. It provides the
 * screenContent() API that all callers use. The Guardian does the work.
 *
 * Sprint 3b enhancement: After a Guardian block with attributeToUser=true,
 * the Sentinel is fired asynchronously to record a strike and evaluate
 * account consequences. The block response returns immediately — the
 * Sentinel runs in the background.
 *
 * Note: The COPPA consent gate (coppa-gate.ts) runs BEFORE this middleware,
 * at the API route level. Order: auth → account status → COPPA gate → here.
 *
 * Backward compatible: callers that don't pass ScreeningContext get
 * contentType "generation" (standard, no adjustments) and level 1
 * (strictest — "treat all as minors" per ADR-016).
 *
 * Usage:
 *   import { screenContent } from "@/platform/moderation";
 *
 *   // Simple (backward compatible with existing callers)
 *   const result = await screenContent(text, { direction: "input", requestId });
 *
 *   // Full context (new callers)
 *   const result = await screenContent(text, {
 *     direction: "input",
 *     requestId: "req-123",
 *     context: {
 *       contentType: "generation",
 *       contentRatingLevel: 2,
 *       userId: "user-456",
 *       sourceLanguage: "ar",
 *       targetLanguage: "en",
 *     },
 *   });
 */

import type {
  ScreeningDirection,
  ScreeningContext,
  ModerationResult,
  ContentRatingLevel,
} from "./types";
import { getGuardian } from "./guardian";
import { getSentinel } from "./sentinel";
import { submitForReview } from "./review-service";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Screening options
// ---------------------------------------------------------------------------

export interface ScreeningOptions {
  /** Direction: user input or AI output */
  direction: ScreeningDirection;
  /** Request ID for trace correlation */
  requestId: string;
  /** Rich screening context. Defaults to { contentType: "generation" } if omitted. */
  context?: ScreeningContext;
  /**
   * @deprecated Use context.contentRatingLevel instead.
   * Kept for backward compatibility — if context is not provided,
   * this value is used for the content rating level.
   */
  contentRatingLevel?: ContentRatingLevel;
}

// ---------------------------------------------------------------------------
// Main screening function
// ---------------------------------------------------------------------------

/**
 * Screen content through the Guardian agent pipeline.
 * Returns a ModerationResult with action, reasoning, and trajectory.
 *
 * If the Guardian blocks with attributeToUser=true and a userId is known, the Sentinel records
 * a strike and evaluates account consequences; an escalation is submitted to the review queue.
 * Both finish before the result is returned (audit D-14), and neither can change it.
 */
export async function screenContent(
  text: string,
  options: ScreeningOptions
): Promise<ModerationResult> {
  // Build context from options (backward compatible)
  const context: ScreeningContext = options.context ?? {
    contentType: options.direction === "output" ? "ai-output" : "generation",
    contentRatingLevel: options.contentRatingLevel ?? 1,
  };

  // Merge contentRatingLevel from options if not in context
  const mergedContext: ScreeningContext = {
    ...context,
    contentRatingLevel: context.contentRatingLevel ?? options.contentRatingLevel ?? 1,
  };

  const result = await getGuardian().screen(
    text,
    options.direction,
    options.requestId,
    mergedContext
  );

  // The consequences are recorded before the result is returned (audit D-14, X-22, RR-8). Before:
  // both ran after the response, and a serverless platform freezes the function once it has
  // answered, so a strike or a review item could be lost without a trace. A failure is logged
  // and never undoes the decision; the block or withholding stands either way.
  if (result.action === "block" && result.attributeToUser && mergedContext.userId) {
    await runSentinel(result, mergedContext.userId, options.requestId);
  }

  // An escalation goes to the review queue — unless nothing was judged (a classifier outage, or
  // an answer that is not a judgement): the content is withheld, and a reviewer would have
  // nothing to decide (RR-8: one outage filled the queue with every prompt; review 8 M4: a user
  // whose prompts draw unreadable answers could fill it the same way). Each is counted, for the
  // alert (moderation.screening_unjudged — docs/ASSURANCE.md).
  if (result.screeningUnavailable) {
    recordUnjudged(result, mergedContext.userId, options.requestId);
  } else if (result.action === "escalate" && mergedContext.userId) {
    await submitEscalation(result, mergedContext.userId, options.requestId);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Unjudged screenings — withheld, never queued, counted (review 8 M4)
// ---------------------------------------------------------------------------

/** Why nothing was judged. */
export type UnjudgedReason = "unavailable" | "unreadable";

const unjudgedCounts: Record<UnjudgedReason, number> = { unavailable: 0, unreadable: 0 };

/**
 * Screenings this instance withheld because nothing was judged, by reason, since it started (or
 * since resetUnjudgedCounts). Each one is also logged with `metric: "moderation.screening_unjudged"`
 * — the signal the alert is built on: a rise means the classifier is down, or answering in a
 * form the parser cannot read (a model change), and content is being withheld.
 */
export function getUnjudgedCounts(): Readonly<Record<UnjudgedReason, number>> {
  return { ...unjudgedCounts };
}

/** Tests only. */
export function resetUnjudgedCounts(): void {
  unjudgedCounts.unavailable = 0;
  unjudgedCounts.unreadable = 0;
}

function recordUnjudged(
  result: ModerationResult,
  userId: string | undefined,
  requestId: string
): void {
  const reason: UnjudgedReason = result.unjudgedReason ?? "unavailable";
  unjudgedCounts[reason]++;
  logger.warn("Screening not judged — content withheld, not queued for review", {
    metric: "moderation.screening_unjudged",
    reason,
    count: unjudgedCounts[reason],
    ...(userId ? { userId } : {}),
    requestId,
    route: "platform/moderation/middleware",
  });
}

// ---------------------------------------------------------------------------
// Sentinel hook
// ---------------------------------------------------------------------------

/**
 * Run the Sentinel after a Guardian block: it records the strike and evaluates consequences.
 * The Guardian's block is already final — the user sees "blocked" whatever happens here — so a
 * failure is logged with what is needed to reconcile the strike by hand, and never thrown.
 */
async function runSentinel(
  result: ModerationResult,
  userId: string,
  requestId: string
): Promise<void> {
  try {
    const sentinelResult = await getSentinel().processBlock(result, userId, requestId);
    if (sentinelResult.consequenceAction !== "none") {
      logger.info("Sentinel consequence applied", {
        userId,
        action: sentinelResult.consequenceAction,
        previousStatus: sentinelResult.previousStatus,
        newStatus: sentinelResult.newStatus,
        totalActiveStrikes: sentinelResult.strikeSummary.totalActive,
        trajectoryId: sentinelResult.trajectoryId,
        requestId,
        route: "platform/moderation/middleware",
      });
    }
  } catch (err) {
    // F1: Full reconstruction payload so a missed strike can be reconciled by hand.
    logger.error("Sentinel processing failed — strike may not be recorded", {
      userId,
      requestId,
      guardianAction: result.action,
      triggeredBy: result.triggeredBy,
      contentType: result.contentType,
      severity: result.classifierOutput?.severity ?? "unknown",
      categories: result.classifierOutput?.categories?.join(",") ?? "unknown",
      guardianTrajectoryId: result.trajectoryId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/moderation/middleware",
    });
  }
}

// ---------------------------------------------------------------------------
// Review queue hook
// ---------------------------------------------------------------------------

/** Submit an escalation to the review queue. Failures are logged and never thrown. */
async function submitEscalation(
  result: ModerationResult,
  userId: string,
  requestId: string
): Promise<void> {
  try {
    const reviewResult = await submitForReview({
      source: "escalation",
      moderationResult: result,
      targetUserId: userId,
      requestId,
    });
    if (reviewResult.success) {
      logger.info("Review queue: escalation submitted", {
        userId,
        reviewItemId: reviewResult.item?.id,
        requestId,
        route: "platform/moderation/middleware",
      });
    } else {
      logger.error("Review queue: escalation submit failed", {
        userId,
        requestId,
        error: reviewResult.error,
        route: "platform/moderation/middleware",
      });
    }
  } catch (err) {
    logger.error("Review queue: escalation submit error", {
      userId,
      requestId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/moderation/middleware",
    });
  }
}
