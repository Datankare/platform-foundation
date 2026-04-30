/**
 * prompts/social/curator-v1.ts — Content digest prompt
 *
 * Creates personalized content digests from group activity.
 * Returns structured digest with prioritized items.
 *
 * P6:  Structured JSON output
 * P11: Fail-closed parse → empty digest
 * P12: Uses fast tier for frequent digest generation
 *
 * @module prompts/social
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for the curator prompt */
export interface CuratorInput {
  readonly groupName: string;
  readonly userId: string;
  readonly recentActivity: readonly string[];
}

/** A single digest item */
export interface DigestItem {
  readonly title: string;
  readonly summary: string;
  readonly priority: "high" | "medium" | "low";
}

/** Complete digest */
export interface ContentDigest {
  readonly items: readonly DigestItem[];
  readonly generatedAt: string;
}

/** Prompt configuration */
export const CURATOR_V1 = {
  name: "curator",
  version: 1,
  tier: "fast" as const,
  maxTokens: 512,
  temperature: 0.3,
} as const;

/**
 * Build the curator prompt.
 */
export function buildCuratorPrompt(input: CuratorInput): string {
  const activity = input.recentActivity
    .map((a) => `- ${sanitizeForPrompt(a)}`)
    .join("\n");

  return `You are a content curation agent. Create a personalized digest of recent group activity for this user.

Group: ${sanitizeForPrompt(input.groupName)}
Recent activity:
${activity}

Respond with ONLY a JSON array. No markdown, no code fences, no explanation.
Each element: { "title": "...", "summary": "...", "priority": "high" | "medium" | "low" }

Rules:
- 1-5 digest items, sorted by priority (high first)
- title: concise headline (under 10 words)
- summary: 1-2 sentence description
- priority: "high" for actionable/urgent, "medium" for interesting, "low" for informational
- If no meaningful activity, return empty array []`;
}

const VALID_PRIORITIES = new Set<string>(["high", "medium", "low"]);

/**
 * Parse curator response. Fail-closed: returns empty digest.
 */
export function parseCuratorResponse(raw: string): readonly DigestItem[] {
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
        (d: Record<string, unknown>) =>
          typeof d.title === "string" &&
          typeof d.summary === "string" &&
          VALID_PRIORITIES.has(d.priority as string)
      )
      .slice(0, 5)
      .map((d: Record<string, unknown>) => ({
        title: d.title as string,
        summary: d.summary as string,
        priority: d.priority as "high" | "medium" | "low",
      }));
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return [];
  }
}
