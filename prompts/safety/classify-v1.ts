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
  | "harassment"
  | "sexual"
  | "violence"
  | "self-harm"
  | "hate"
  | "dangerous";

/** Severity levels per ADR-016 */
export type SafetySeverity = "low" | "medium" | "high" | "critical";

/** Structured classifier output */
export interface ClassifierOutput {
  safe: boolean;
  categories: SafetyCategory[];
  confidence: number;
  severity: SafetySeverity;
  reason?: string;
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
 */
export function parseClassifierResponse(raw: string): ClassifierOutput {
  const cleaned = raw
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    const result = JSON.parse(cleaned);

    // Validate required fields — fail closed on missing data
    if (typeof result.safe !== "boolean") {
      return failClosedResult("Missing 'safe' field");
    }

    const categories: SafetyCategory[] = Array.isArray(result.categories)
      ? result.categories.filter(isValidCategory)
      : [];

    const confidence =
      typeof result.confidence === "number"
        ? Math.max(0, Math.min(1, result.confidence))
        : 0.5;

    const severity = isValidSeverity(result.severity) ? result.severity : "medium";

    return {
      safe: result.safe,
      categories,
      confidence,
      severity,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    };
  } catch {
    /* justified — fail closed on parse error */
    return failClosedResult("Failed to parse classifier response");
  }
}

function failClosedResult(reason: string): ClassifierOutput {
  return {
    safe: false,
    categories: [],
    confidence: 0.5,
    severity: "medium",
    reason,
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
