/**
 * prompts/social/analyst-v1.ts — Group health analysis prompt
 *
 * Analyzes group health metrics and detects anomalies.
 * Returns structured health report.
 *
 * P6:  Structured JSON output
 * P11: Fail-closed parse → unknown health status
 * P12: Uses standard tier for nuanced analysis
 *
 * @module prompts/social
 */

import { sanitizeForPrompt } from "@/lib/sanitize";
import { logger } from "@/lib/logger";

/** Input for the analyst prompt */
export interface AnalystInput {
  readonly groupName: string;
  readonly memberCount: number;
  readonly recentActivitySummary: string;
  /** Previous health report for trend comparison (P16 cognitive memory) */
  readonly previousReport?: HealthReport;
}

/** Health status levels */
export type HealthStatus = "healthy" | "at-risk" | "declining" | "unknown";

/** Group health report */
export interface HealthReport {
  readonly status: HealthStatus;
  readonly score: number;
  readonly insights: readonly string[];
  readonly anomalies: readonly string[];
}

/** Prompt configuration */
export const ANALYST_V1 = {
  name: "analyst",
  version: 1,
  tier: "standard" as const,
  maxTokens: 512,
  temperature: 0.2,
} as const;

/**
 * Build the analyst prompt.
 */
export function buildAnalystPrompt(input: AnalystInput): string {
  return `You are a group health analysis agent. Evaluate the health of this group based on the provided metrics and activity summary.

Group: ${sanitizeForPrompt(input.groupName)}
Member count: ${input.memberCount}
Recent activity: ${sanitizeForPrompt(input.recentActivitySummary)}${input.previousReport ? `\nPrevious assessment: status=${input.previousReport.status}, score=${input.previousReport.score}` : ""}

Respond with ONLY a JSON object. No markdown, no code fences, no explanation.
{
  "status": "healthy" | "at-risk" | "declining",
  "score": 0.0-1.0,
  "insights": ["insight 1", "insight 2"],
  "anomalies": ["anomaly 1"] or []
}

Rules:
- "healthy": score >= 0.7, active engagement, no anomalies
- "at-risk": score 0.4-0.69, declining engagement or minor issues
- "declining": score < 0.4, significant problems
- insights: 2-4 brief observations about group dynamics
- anomalies: unusual patterns (empty array if none detected)`;
}

const VALID_STATUSES = new Set<string>(["healthy", "at-risk", "declining"]);

/**
 * Parse analyst response. Fail-closed: returns unknown health status.
 */
export function parseAnalystResponse(raw: string): HealthReport {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);

    const status: HealthStatus = VALID_STATUSES.has(result.status)
      ? (result.status as HealthStatus)
      : "unknown";
    const score =
      typeof result.score === "number" ? Math.max(0, Math.min(1, result.score)) : 0;
    const insights = Array.isArray(result.insights)
      ? result.insights.filter((i: unknown) => typeof i === "string").slice(0, 4)
      : [];
    const anomalies = Array.isArray(result.anomalies)
      ? result.anomalies.filter((a: unknown) => typeof a === "string").slice(0, 4)
      : [];

    return { status, score, insights, anomalies };
  } catch {
    logger.debug("Prompt parse failed — returning safe default", { raw: cleaned });
    return { status: "unknown", score: 0, insights: [], anomalies: [] };
  }
}
