/**
 * prompts/social/matchmaker-v1.ts — Group recommendation prompt
 *
 * Recommends groups for a user based on interests and available groups.
 * Returns ranked recommendations with reasoning.
 *
 * P6:  Structured JSON output
 * P11: Fail-closed parse → empty recommendations
 * P15: Agent identity in prompt context
 *
 * @module prompts/social
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for the matchmaker prompt */
export interface MatchmakerInput {
  readonly userId: string;
  readonly userInterests: readonly string[];
  readonly candidateGroups: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly memberCount: number;
  }[];
  /** IDs of previously recommended groups to avoid repeating (P16 cognitive memory) */
  readonly previouslyRecommended?: readonly string[];
}

/** A single group recommendation */
export interface MatchmakerRecommendation {
  readonly groupId: string;
  readonly score: number;
  readonly reason: string;
}

/** Prompt configuration */
export const MATCHMAKER_V1 = {
  name: "matchmaker",
  version: 1,
  tier: "standard" as const,
  maxTokens: 512,
  temperature: 0.3,
} as const;

/**
 * Build the matchmaker prompt.
 */
export function buildMatchmakerPrompt(input: MatchmakerInput): string {
  const groupList = input.candidateGroups
    .map(
      (g) =>
        `- ID: ${sanitizeForPrompt(g.id)}, Name: ${sanitizeForPrompt(g.name)}, Description: ${sanitizeForPrompt(g.description)}, Members: ${g.memberCount}`
    )
    .join("\n");

  const interests = input.userInterests.map((i) => sanitizeForPrompt(i)).join(", ");

  return `You are a group recommendation agent. Given a user's interests and available groups, recommend the best matches.

User interests: ${interests}

Available groups:
${groupList}

Respond with ONLY a JSON array. No markdown, no code fences, no explanation.
Each element: { "groupId": "...", "score": 0.0-1.0, "reason": "brief reason" }
Sort by score descending. Include only groups with score >= 0.3.${input.previouslyRecommended && input.previouslyRecommended.length > 0 ? `\nPreviously recommended (deprioritize): ${input.previouslyRecommended.join(", ")}` : ""}
If no groups match, return an empty array [].`;
}

/**
 * Parse matchmaker response. Fail-closed: returns empty array on parse error.
 */
export function parseMatchmakerResponse(
  raw: string
): readonly MatchmakerRecommendation[] {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);
    if (!Array.isArray(result)) {
      return [];
    }
    return result
      .filter(
        (r: Record<string, unknown>) =>
          typeof r.groupId === "string" &&
          typeof r.score === "number" &&
          typeof r.reason === "string" &&
          r.score >= 0.3
      )
      .map((r: Record<string, unknown>) => ({
        groupId: r.groupId as string,
        score: Math.max(0, Math.min(1, r.score as number)),
        reason: r.reason as string,
      }));
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return [];
  }
}
