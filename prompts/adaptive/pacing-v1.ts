/**
 * prompts/adaptive/pacing-v1.ts — Reference adaptive behavior prompt (ADR-036 step 4).
 *
 * The canonical reference an adaptive behavior binds to (ADR-036) and the template ADR-037
 * copies. Given a scope's recent within-session outcome summaries, it recommends a pacing level
 * for how assertively an agent should act next. It is a recommendation the framework routes
 * through the D3 governed-effect pipeline — not an auto-decision.
 *
 * P6:  Structured JSON output
 * P10: Produces a recommendation, not an auto-decision (the effect step governs it)
 * P11: Fail-closed parse → "steady" (the neutral no-op)
 *
 * @module prompts/adaptive
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for the pacing prompt. `recentSummaries` are compact prior-decision summaries for this
 *  session (most recent last) — plain strings, so this prompt stays decoupled from the
 *  platform/adaptive memory types; the behavior maps AdaptiveMemory into them in step 4b. */
export interface PacingInput {
  readonly scopeLabel: string;
  readonly signal: string;
  readonly recentSummaries: readonly string[];
}

/** Pacing recommendation. */
export type PacingDecision = "accelerate" | "steady" | "slow" | "pause";

/** Pacing evaluation result. */
export interface PacingDecisionResult {
  readonly decision: PacingDecision;
  readonly confidence: number;
  readonly rationale: string;
}

/** Prompt configuration. */
export const PACING_V1 = {
  name: "adaptive-pacing",
  version: 1,
  tier: "standard" as const,
  maxTokens: 256,
  temperature: 0.1,
} as const;

/**
 * Build the pacing prompt.
 */
export function buildPacingPrompt(input: PacingInput): string {
  const history =
    input.recentSummaries.length > 0
      ? input.recentSummaries.map((s) => `- ${sanitizeForPrompt(s)}`).join("\n")
      : "- (none this session)";

  return `You are an action-pacing agent. Recommend how assertively the agent should act on this scope next, given the recent signal. Your recommendation is reviewed and governed by the platform — you do not make the final change.

Scope: ${sanitizeForPrompt(input.scopeLabel)}
Current signal: ${sanitizeForPrompt(input.signal)}
Recent decisions this session (most recent last):
${history}

Respond with ONLY a JSON object. No markdown, no code fences, no explanation.
{
  "decision": "accelerate" | "steady" | "slow" | "pause",
  "confidence": 0.0-1.0,
  "rationale": "brief explanation for the reviewer"
}

Rules:
- "accelerate": signal is strongly positive — act more assertively
- "steady": no clear reason to change the current pace
- "slow": signal is weak or mixed — act less assertively
- "pause": signal is negative or unsafe — stop acting until it clears
- When in doubt, choose "steady" (fail-safe no-op)
- Keep rationale under 100 words`;
}

const VALID_DECISIONS = new Set<string>(["accelerate", "steady", "slow", "pause"]);

/**
 * Parse pacing response. Fail-closed: returns "steady" (the neutral no-op) on any parse error
 * or unrecognized decision.
 */
export function parsePacingResponse(raw: string): PacingDecisionResult {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);

    const decision = VALID_DECISIONS.has(result.decision) ? result.decision : "steady";
    const confidence =
      typeof result.confidence === "number"
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5;
    const rationale =
      typeof result.rationale === "string" ? result.rationale : "Unable to evaluate";

    return { decision, confidence, rationale };
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return { decision: "steady", confidence: 0, rationale: "Failed to parse evaluation" };
  }
}
