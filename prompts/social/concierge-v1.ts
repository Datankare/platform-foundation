/**
 * prompts/social/concierge-v1.ts — Onboarding steps prompt
 *
 * Generates personalized onboarding ActionItem[] for new group members.
 * Uses the same ActionItem contract as the input agent layer.
 *
 * P6:  Structured JSON output matching ActionItem schema
 * P10: Actions are suggestions — user decides what to do
 * P11: Fail-closed parse → default welcome action
 *
 * @module prompts/social
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for the concierge prompt */
export interface ConciergeInput {
  readonly groupName: string;
  readonly groupDescription: string;
  readonly memberName: string;
}

/** Onboarding action matching the ActionItem contract */
export interface OnboardingAction {
  readonly id: string;
  readonly label: string;
  readonly primary: boolean;
}

/** Prompt configuration */
export const CONCIERGE_V1 = {
  name: "concierge",
  version: 1,
  tier: "fast" as const,
  maxTokens: 512,
  temperature: 0.4,
} as const;

/**
 * Build the concierge prompt.
 */
export function buildConciergePrompt(input: ConciergeInput): string {
  return `You are an onboarding agent for a social group. Generate 3-5 personalized first-time actions for a new member.

Group: ${sanitizeForPrompt(input.groupName)}
Group description: ${sanitizeForPrompt(input.groupDescription)}
New member: ${sanitizeForPrompt(input.memberName)}

Respond with ONLY a JSON array. No markdown, no code fences, no explanation.
Each element: { "id": "action-slug", "label": "Human-readable label", "primary": true/false }

Rules:
- First action should be primary (primary: true), rest are secondary (primary: false)
- IDs must be kebab-case, unique, and descriptive (e.g., "introduce-yourself")
- Labels should be friendly and specific to the group context
- 3-5 actions total — do not exceed 5
- Actions should be achievable in the first session`;
}

/**
 * Parse concierge response. Fail-closed: returns default welcome action.
 */
export function parseConciergeResponse(raw: string): readonly OnboardingAction[] {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);
    if (!Array.isArray(result) || result.length === 0) {
      return defaultOnboardingActions();
    }
    return result
      .filter(
        (a: Record<string, unknown>) =>
          typeof a.id === "string" &&
          typeof a.label === "string" &&
          typeof a.primary === "boolean"
      )
      .slice(0, 5)
      .map((a: Record<string, unknown>) => ({
        id: a.id as string,
        label: a.label as string,
        primary: a.primary as boolean,
      }));
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return defaultOnboardingActions();
  }
}

function defaultOnboardingActions(): readonly OnboardingAction[] {
  return [
    { id: "welcome-intro", label: "Introduce yourself to the group", primary: true },
  ];
}
