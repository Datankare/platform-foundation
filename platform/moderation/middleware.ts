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
 *       contentType: "translation",
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
  /**
   * Skip the LLM classifier (use blocklist only).
   * @deprecated Use config: moderation.blocklist_only_surfaces instead.
   */
  blocklistOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Main screening function
// ---------------------------------------------------------------------------

/**
 * Screen content through the Guardian agent pipeline.
 * Returns a ModerationResult with action, reasoning, and trajectory.
 *
 * Sprint 3b: If the Guardian blocks with attributeToUser=true and a
 * userId is known, the Sentinel is fired asynchronously to record a
 * strike and evaluate account consequences. The block result is returned
 * immediately — the Sentinel runs in the background.
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

  // Sprint 3b: Fire Sentinel on block + attributeToUser + known userId
  if (result.action === "block" && result.attributeToUser && mergedContext.userId) {
    fireSentinel(result, mergedContext.userId, options.requestId);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sentinel hook (async, non-blocking)
// ---------------------------------------------------------------------------

/**
 * Fire the Sentinel agent asynchronously after a Guardian block.
 *
 * This is intentionally non-blocking — the block response goes back to
 * the user immediately. The Sentinel records the strike and evaluates
 * consequences in the background.
 *
 * The Sentinel itself is L19-compliant (strike recording returns success/error).
 * But from the middleware's perspective, the Sentinel is fire-and-forget
 * because the Guardian's block decision is already final — the user sees
 * "blocked" regardless of whether the strike was recorded.
 *
 * Errors are logged but never thrown.
 */
function fireSentinel(result: ModerationResult, userId: string, requestId: string): void {
  getSentinel()
    .processBlock(result, userId, requestId)
    .then((sentinelResult) => {
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
    })
    .catch((err) => {
      logger.error("Sentinel processing failed — strike may not be recorded", {
        userId,
        requestId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/moderation/middleware",
      });
    });
}
