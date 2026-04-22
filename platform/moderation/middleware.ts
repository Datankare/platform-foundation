/**
 * platform/moderation/middleware.ts — Universal content safety middleware
 *
 * ADR-016: Applied at every input surface.
 * ADR-017 §1: Applied at every output surface.
 *
 * This is a thin wrapper around the Guardian agent. It provides the
 * screenContent() API that all callers use. The Guardian does the work.
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

  return getGuardian().screen(text, options.direction, options.requestId, mergedContext);
}
