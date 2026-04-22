/**
 * platform/moderation/context.ts — Content-type context evaluation
 *
 * Evaluates the screening context to determine severity adjustments
 * and behavioral differences based on content type.
 *
 * The key insight: a user translating a historical document about
 * violence is fundamentally different from a user generating violent
 * content. Context-aware moderation reduces false positives without
 * reducing safety for actual harmful content generation.
 *
 * P17: These evaluations are cognition (internal, revisable).
 *      The Guardian uses them to inform its decision, not as final actions.
 */

import type { SafetySeverity } from "@/prompts/safety/classify-v1";
import type { ScreeningContext } from "./types";
import { loadSeverityReduction } from "./config";

const VALID_CONTENT_TYPES = new Set([
  "translation",
  "generation",
  "transcription",
  "extraction",
  "profile",
  "social",
  "ai-output",
]);

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<SafetySeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const RANK_TO_SEVERITY: SafetySeverity[] = ["low", "medium", "high", "critical"];

/**
 * Reduce a severity level by a number of steps.
 * Cannot go below "low". Critical content type reduction
 * is capped — critical is never reduced below "medium".
 */
export function reduceSeverity(
  severity: SafetySeverity,
  reduction: number
): SafetySeverity {
  if (reduction <= 0) return severity;

  const rank = SEVERITY_RANK[severity];
  // Critical content is never reduced below medium (safety floor)
  const floor = severity === "critical" ? 1 : 0;
  const newRank = Math.max(floor, rank - reduction);
  return RANK_TO_SEVERITY[newRank];
}

// ---------------------------------------------------------------------------
// Context evaluation
// ---------------------------------------------------------------------------

/**
 * Result of evaluating the screening context.
 * The Guardian uses this to adjust its decision.
 */
export interface ContextEvaluation {
  /** Number of severity levels to reduce (0 = no adjustment) */
  readonly severityReduction: number;
  /** Whether to attribute strikes to the user */
  readonly attributeToUser: boolean;
  /** Context factors that influenced the evaluation */
  readonly factors: string[];
  /** Whether to skip the classifier (blocklist-only mode) */
  readonly blocklistOnly: boolean;
}

/**
 * Evaluate the screening context to determine adjustments.
 *
 * This is the Guardian's "Step 0: receive-context" — it gathers
 * context signals before running the pipeline tools.
 */
export async function evaluateContext(
  context: ScreeningContext
): Promise<ContextEvaluation> {
  if (!VALID_CONTENT_TYPES.has(context.contentType)) {
    return {
      severityReduction: 0,
      attributeToUser: true,
      factors: ["unknown-content-type: treated as generation"],
      blocklistOnly: false,
    };
  }

  const factors: string[] = [];
  let severityReduction = 0;
  let attributeToUser = true;
  const blocklistOnly = false;

  // ── Content type adjustments ───────────────────────────────────────

  const reduction = await loadSeverityReduction(context.contentType);
  if (reduction > 0) {
    severityReduction = reduction;
    factors.push(`${context.contentType}-content: severity reduced by ${reduction}`);
  }

  // AI output never penalizes the user
  if (context.contentType === "ai-output") {
    attributeToUser = false;
    factors.push("ai-output: strikes not attributed to user");
  }

  // ── User history adjustments ───────────────────────────────────────

  if (context.userHistory) {
    const { totalScreenings, recentFlags, activeStrikes } = context.userHistory;

    // Clean history = slight leniency on borderline cases
    if (totalScreenings > 100 && recentFlags === 0 && activeStrikes === 0) {
      factors.push("clean-history: user has long clean record");
      // Note: clean history is a FACTOR, not an adjustment.
      // It provides context for human reviewers on escalated cases.
    }

    // Recent pattern of flags = heightened scrutiny
    if (recentFlags >= 3) {
      factors.push("repeat-flags: 3+ flags in last 24h");
      // No severity INCREASE — we don't make the pipeline harsher.
      // But this factor is recorded for human reviewers.
    }
  }

  // ── Language context ───────────────────────────────────────────────

  if (context.sourceLanguage || context.targetLanguage) {
    factors.push(
      `language-context: ${context.sourceLanguage ?? "auto"} → ${context.targetLanguage ?? "unknown"}`
    );
  }

  return {
    severityReduction,
    attributeToUser,
    factors,
    blocklistOnly,
  };
}
