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

import { getGuardian } from "@/platform/moderation/guardian";
import { generateId } from "@/platform/agents/utils";
import type { ScreenContentFn } from "./group-service";
import type { ContentType } from "@/platform/moderation/types";
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
 */
export function createGuardianScreenFn(): ScreenContentFn {
  return async (
    text: string,
    contentType: "group-name" | "group-description"
  ): Promise<string | null> => {
    try {
      const guardian = getGuardian();
      const requestId = `social-screen-${generateId()}`;
      const result = await guardian.screen(text, "input", requestId, {
        contentType: toModerationContentType(contentType),
        contentRatingLevel: 3,
      });

      if (result.action === "block") {
        return result.reasoning || "Content contains prohibited material";
      }

      if (result.action === "escalate") {
        return "Content requires review and cannot be used at this time";
      }

      return null;
    } catch (err) {
      logger.error("Guardian screening failed — blocking content (fail-closed)", {
        contentType,
        error: err instanceof Error ? err.message : "Unknown",
      });
      return "Content screening is temporarily unavailable. Please try again later.";
    }
  };
}
