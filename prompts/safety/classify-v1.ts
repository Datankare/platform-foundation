/**
 * prompts/safety/classify-v1.ts — Content safety classification prompt
 *
 * Version: 1
 * Extracted from: lib/safety.ts (Phase 0)
 * ADR-015: Prompts are first-class versioned artifacts.
 * ADR-016: Structured classifier output (categories, confidence, severity).
 *
 * Phase 2 upgrade: binary safe/unsafe → structured classification with
 * categories, confidence score, and severity level.
 */

import { sanitizeForPrompt } from "@/lib/sanitize";

/** Safety classification categories per ADR-016 */
export type SafetyCategory =
  "harassment" | "sexual" | "violence" | "self-harm" | "hate" | "dangerous";

/** Severity levels per ADR-016 */
export type SafetySeverity = "low" | "medium" | "high" | "critical";

/** Structured classifier output */
export interface ClassifierOutput {
  safe: boolean;
  categories: SafetyCategory[];
  confidence: number;
  severity: SafetySeverity;
  reason?: string;
  /**
   * True when the answer could not be read (a parse failure or missing field): the confidence and
   * severity are placeholders, not a judgement, so no threshold may clear the text on them
   * (review 7 H1 — at level 3 the placeholder 0.5/medium was below every threshold and allowed).
   */
  unjudged?: true;
}

/** Prompt configuration */
export const SAFETY_CLASSIFY_V1 = {
  name: "safety-classify",
  version: 1,
  tier: "fast" as const,
  maxTokens: 128,
  temperature: 0,
} as const;

/**
 * Build the safety classification prompt for a given text input.
 * Input is sanitized before embedding in the prompt.
 */
export function buildSafetyPrompt(text: string): string {
  return `You are a content safety classifier for a platform used by all age groups including minors. Analyze the following text and respond with ONLY a JSON object. No markdown, no code fences, no explanation.

Text to analyze: ${sanitizeForPrompt(text)}

Respond with exactly this JSON format:
{
  "safe": true/false,
  "categories": [],
  "confidence": 0.0-1.0,
  "severity": "low"/"medium"/"high"/"critical",
  "reason": "brief reason if unsafe, omit if safe"
}

Categories (include ALL that apply, empty array if safe):
- "harassment": bullying, threats, intimidation
- "sexual": sexual content, suggestive material
- "violence": graphic violence, gore, weapons
- "self-harm": self-injury, suicide, eating disorders
- "hate": hate speech, discrimination, slurs
- "dangerous": illegal activities, dangerous instructions

Rules:
- Treat all users as potentially minors — strict threshold
- confidence: your certainty in the classification (0.0 = uncertain, 1.0 = certain)
- severity: "low" = borderline, "medium" = clearly inappropriate, "high" = harmful, "critical" = dangerous/illegal
- If safe, categories must be empty array, severity must be "low", confidence should be high
- JSON only, no backticks, no markdown:`;
}

/**
 * Parse the classifier response into a structured ClassifierOutput.
 * Fails closed — any parse error returns unsafe with low confidence.
 *
 * Every field is required and checked (review 8 H-B): a missing or non-numeric confidence, one
 * outside 0–1, a severity not exactly one of the four, categories that are not a list of known
 * ones, a reason that is not text, or a "safe" verdict that contradicts itself (categories, or a
 * severity above low) — any of them makes the answer unjudged. Before: a missing confidence
 * became 0.5 and an unknown severity ("High", "severe") became "medium", unmarked, and at level 3
 * those placeholders cleared an unsafe answer. Unjudged is never allowed (the Guardian withholds
 * it at every level).
 */
export function parseClassifierResponse(raw: string): ClassifierOutput {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failClosedResult("Classifier answer is not a JSON object");
    }
    result = parsed as Record<string, unknown>;
  } catch {
    /* justified — fail closed on parse error */
    return failClosedResult("Failed to parse classifier response");
  }

  // Validate required fields — fail closed on missing data
  if (typeof result.safe !== "boolean") {
    return failClosedResult("Missing 'safe' field");
  }

  const problems: string[] = [];
  const categories: SafetyCategory[] = Array.isArray(result.categories)
    ? result.categories.filter(isValidCategory)
    : [];
  if (!Array.isArray(result.categories)) problems.push("categories missing");
  else if (categories.length !== result.categories.length)
    problems.push("unknown category");

  const confidenceValid =
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1;
  if (!confidenceValid) problems.push("confidence missing or outside 0–1");
  const confidence = confidenceValid ? (result.confidence as number) : 0.5;

  const severityValid = isValidSeverity(result.severity);
  if (!severityValid) problems.push("severity missing or unknown");
  const severity: SafetySeverity = severityValid
    ? (result.severity as SafetySeverity)
    : "medium";

  // `reason` is the one optional field: absent and null both mean "no reason given" (review 9
  // M3 — a safe answer with "reason": null was marked unjudged). The required fields above stay
  // strict: null is not a verdict, a list, a confidence or a severity.
  if (
    result.reason !== undefined &&
    result.reason !== null &&
    typeof result.reason !== "string"
  )
    problems.push("reason is not text");
  if (result.safe && (categories.length > 0 || (severityValid && severity !== "low")))
    problems.push("a safe verdict with categories or a severity above low");

  const reason = typeof result.reason === "string" ? result.reason : undefined;
  if (problems.length > 0) {
    // Partly readable: not a judgement. Never "safe", and marked, so no threshold clears it.
    return {
      safe: false,
      categories,
      confidence,
      severity,
      reason: `Classifier answer not fully readable (${problems.join("; ")})`,
      unjudged: true,
    };
  }
  return {
    safe: result.safe,
    categories,
    confidence,
    severity,
    reason,
  };
}

function failClosedResult(reason: string): ClassifierOutput {
  return {
    safe: false,
    categories: [],
    confidence: 0.5,
    severity: "medium",
    reason,
    unjudged: true,
  };
}

const VALID_CATEGORIES = new Set<string>([
  "harassment",
  "sexual",
  "violence",
  "self-harm",
  "hate",
  "dangerous",
]);

function isValidCategory(value: unknown): value is SafetyCategory {
  return typeof value === "string" && VALID_CATEGORIES.has(value);
}

const VALID_SEVERITIES = new Set<string>(["low", "medium", "high", "critical"]);

function isValidSeverity(value: unknown): value is SafetySeverity {
  return typeof value === "string" && VALID_SEVERITIES.has(value);
}
