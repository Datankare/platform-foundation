/**
 * prompts/social/gatekeeper-v1.ts — Join request evaluation prompt
 *
 * Evaluates whether a user is a good fit for a group.
 * Returns a recommendation for admin review (P10).
 *
 * P6:  Structured JSON output
 * P10: Produces recommendation, not auto-decision
 * P11: Fail-closed parse → "review" recommendation
 *
 * @module prompts/social
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for the gatekeeper prompt */
export interface GatekeeperInput {
  readonly groupName: string;
  readonly groupDescription: string;
  readonly applicantId: string;
  readonly applicantContext: string;
}

/** Gatekeeper decision */
export type GatekeeperDecision = "approve" | "deny" | "review";

/** Gatekeeper evaluation result */
export interface GatekeeperEvaluation {
  readonly decision: GatekeeperDecision;
  readonly confidence: number;
  readonly reason: string;
}

/** Prompt configuration */
export const GATEKEEPER_V1 = {
  name: "gatekeeper",
  version: 1,
  tier: "standard" as const,
  maxTokens: 256,
  temperature: 0.1,
} as const;

/**
 * Build the gatekeeper prompt.
 */
export function buildGatekeeperPrompt(input: GatekeeperInput): string {
  return `You are a group membership evaluation agent. Assess whether this applicant is a good fit for the group. Your recommendation will be reviewed by a human admin — you do not make the final decision.

Group: ${sanitizeForPrompt(input.groupName)}
Group description: ${sanitizeForPrompt(input.groupDescription)}
Applicant context: ${sanitizeForPrompt(input.applicantContext)}

Respond with ONLY a JSON object. No markdown, no code fences, no explanation.
{
  "decision": "approve" | "deny" | "review",
  "confidence": 0.0-1.0,
  "reason": "brief explanation for the admin"
}

Rules:
- "approve": clearly fits group purpose and norms
- "deny": clearly incompatible or policy violation
- "review": uncertain — flag for human review
- When in doubt, choose "review" (fail-safe)
- Keep reason under 100 words`;
}

const VALID_DECISIONS = new Set<string>(["approve", "deny", "review"]);

/**
 * Parse gatekeeper response. Fail-closed: returns "review" on parse error.
 */
export function parseGatekeeperResponse(raw: string): GatekeeperEvaluation {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);

    const decision = VALID_DECISIONS.has(result.decision) ? result.decision : "review";
    const confidence =
      typeof result.confidence === "number"
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5;
    const reason =
      typeof result.reason === "string" ? result.reason : "Unable to evaluate";

    return { decision, confidence, reason };
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return { decision: "review", confidence: 0, reason: "Failed to parse evaluation" };
  }
}
