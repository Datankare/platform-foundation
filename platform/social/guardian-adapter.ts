/**
 * platform/social/guardian-adapter.ts — Guardian content screening adapter
 *
 * Bridges the existing Guardian agent's screen() method to the
 * ScreenContentFn hook used by GroupService. This is the wiring
 * that makes every social write pass through content safety.
 *
 * P4:  Structural safety — all social content screened
 * P7:  Provider-aware — uses existing Guardian singleton
 * P11: Resilient degradation — if Guardian is unavailable, blocks (fail-closed)
 *
 * @module platform/social
 */

import { shown, type ShownText } from "@/platform/errors/shown-text";
import { getGuardian } from "@/platform/moderation/guardian";
import { generateId } from "@/platform/agents/utils";
import type { ScreenContentFn } from "./group-service";
import type { ContentRatingLevel, ContentType } from "@/platform/moderation/types";
import { logger } from "@/lib/logger";

/**
 * Map social content types to moderation content types.
 */
function toModerationContentType(
  _socialType: "group-name" | "group-description"
): ContentType {
  return "social";
}

/**
 * Create a ScreenContentFn that delegates to the Guardian agent.
 *
 * Returns null if content is safe, or an error message if blocked.
 * Fail-closed: if screening throws, content is rejected (P4, P17).
 *
 * Group names and descriptions are shown to every member, whatever their age, so they are
 * screened at the strictest rating (1) unless the caller knows every viewer's (audit D-18:
 * they were screened at the adult rating, 3).
 */
export function createGuardianScreenFn(
  ratingLevel: ContentRatingLevel = 1
): ScreenContentFn {
  return async (
    text: string,
    contentType: "group-name" | "group-description"
  ): Promise<readonly ShownText[] | null> => {
    try {
      const guardian = getGuardian();
      const requestId = `social-screen-${generateId()}`;
      const result = await guardian.screen(text, "input", requestId, {
        contentType: toModerationContentType(contentType),
        contentRatingLevel: ratingLevel,
      });

      // Catalog keys and values (TASK-209: English before), worded where they are shown.
      if (result.action === "block") {
        return typeof result.reasoning !== "string" && result.reasoning.length > 0
          ? result.reasoning
          : [shown("screens.moderation.social.prohibited")];
      }

      if (result.action === "escalate") {
        return [shown("screens.moderation.social.needs_review")];
      }

      return null;
    } catch (err) {
      logger.error("Guardian screening failed — blocking content (fail-closed)", {
        contentType,
        error: err instanceof Error ? err.message : "Unknown",
      });
      return [shown("screens.moderation.social.unavailable")];
    }
  };
}
