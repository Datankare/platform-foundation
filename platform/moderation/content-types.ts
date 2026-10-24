/**
 * platform/moderation/content-types.ts — The kinds of content the pipeline screens (ADR-016)
 *
 * The core's kinds, then each registered module's (ADR-054 D4): translation adds "translation",
 * voice adds "transcription", social adds "social". A kind no registered module declares is
 * screened as generation — the strictest treatment (no severity reduction, strikes attributed).
 *
 * A kind with `severityReduction` may have its classifier severity reduced by the governed
 * `moderation.<kind>_severity_reduction` setting, because the user is processing existing
 * content rather than creating it; the reduction fails closed to none (./config.ts).
 *
 * @module platform/moderation
 */

import { composeValues } from "@/platform/modules/compose";
import type { ModerationContentTypeDefinition } from "@/platform/modules/types";

export type { ModerationContentTypeDefinition } from "@/platform/modules/types";

/** The core's kinds of content. */
export const CORE_MODERATION_CONTENT_TYPES: readonly ModerationContentTypeDefinition[] =
  Object.freeze([
    // creating new content (standard)
    { name: "generation", severityReduction: false },
    // an uploaded document — the content is not the user's
    { name: "extraction", severityReduction: true },
    // display name, bio (stricter for URLs/impersonation)
    { name: "profile", severityReduction: false },
    // an AI-generated response (no user strikes on block — ./context.ts)
    { name: "ai-output", severityReduction: false },
  ]);

/** The core's kinds then each registered module's, each name once (refused otherwise). */
export function listModerationContentTypes(): readonly ModerationContentTypeDefinition[] {
  return composeValues(
    "moderation content type",
    CORE_MODERATION_CONTENT_TYPES,
    (t) => t.name,
    (m) => m.moderationContentTypes
  );
}

/** Whether the core or a registered module declares this kind of content. */
export function isModerationContentType(name: string): boolean {
  return listModerationContentTypes().some((t) => t.name === name);
}

/** Whether this kind may have its severity reduced (unknown kinds may not). */
export function allowsSeverityReduction(name: string): boolean {
  return listModerationContentTypes().some((t) => t.name === name && t.severityReduction);
}
