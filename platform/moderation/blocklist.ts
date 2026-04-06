/**
 * platform/moderation/blocklist.ts — Keyword/pattern pre-screen
 *
 * ADR-016: Layer 1 of multi-layer defense. Instant, zero-cost.
 * Catches known bad patterns before invoking the LLM classifier.
 *
 * Design:
 * - Patterns are in-memory for speed (< 1ms)
 * - Supports exact match, substring, and regex
 * - Returns matched patterns with category and severity
 * - Future: load patterns from database for admin-editable blocklist
 */

import type { BlocklistPattern } from "./types";

// ---------------------------------------------------------------------------
// Default patterns — common obvious violations
// ---------------------------------------------------------------------------

const DEFAULT_PATTERNS: BlocklistPattern[] = [
  // Hate speech / slurs — exact substring matches
  {
    id: "h-001",
    pattern: "kill yourself",
    type: "substring",
    category: "self-harm",
    severity: "critical",
  },
  {
    id: "h-002",
    pattern: "kys",
    type: "exact",
    category: "self-harm",
    severity: "critical",
  },

  // Dangerous instructions
  {
    id: "d-001",
    pattern: "how to make a bomb",
    type: "substring",
    category: "dangerous",
    severity: "critical",
  },
  {
    id: "d-002",
    pattern: "how to make explosives",
    type: "substring",
    category: "dangerous",
    severity: "critical",
  },

  // Sexual content markers
  { id: "s-001", pattern: "nsfw", type: "exact", category: "sexual", severity: "high" },

  // Violence
  {
    id: "v-001",
    pattern: "school shooting",
    type: "substring",
    category: "violence",
    severity: "critical",
  },
  {
    id: "v-002",
    pattern: "mass shooting",
    type: "substring",
    category: "violence",
    severity: "critical",
  },
];

// ---------------------------------------------------------------------------
// Blocklist scanner
// ---------------------------------------------------------------------------

export interface BlocklistMatch {
  patternId: string;
  matched: string;
  category: string;
  severity: string;
}

export interface BlocklistResult {
  /** Whether any patterns matched */
  matched: boolean;
  /** All matches found */
  matches: BlocklistMatch[];
  /** Highest severity among matches */
  maxSeverity: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Scan text against the blocklist patterns.
 * Returns immediately — no async, no API calls.
 */
export function scanBlocklist(
  text: string,
  patterns?: BlocklistPattern[]
): BlocklistResult {
  const activePatterns = patterns ?? DEFAULT_PATTERNS;
  const normalized = text.toLowerCase().trim();
  const matches: BlocklistMatch[] = [];

  for (const pattern of activePatterns) {
    const isMatch = matchPattern(normalized, pattern);
    if (isMatch) {
      matches.push({
        patternId: pattern.id,
        matched: pattern.pattern,
        category: pattern.category,
        severity: pattern.severity,
      });
    }
  }

  const maxSeverity = matches.reduce(
    (max, m) =>
      (SEVERITY_ORDER[m.severity] ?? 0) > (SEVERITY_ORDER[max] ?? 0) ? m.severity : max,
    "low"
  );

  return {
    matched: matches.length > 0,
    matches,
    maxSeverity: matches.length > 0 ? maxSeverity : "low",
  };
}

function matchPattern(text: string, pattern: BlocklistPattern): boolean {
  const normalizedPattern = pattern.pattern.toLowerCase();

  switch (pattern.type) {
    case "exact":
      // Word boundary match — "kys" matches as a word, not inside "keys"
      return new RegExp(`\\b${escapeRegex(normalizedPattern)}\\b`).test(text);

    case "substring":
      return text.includes(normalizedPattern);

    case "regex":
      try {
        return new RegExp(normalizedPattern, "i").test(text);
      } catch {
        /* justified — invalid regex patterns are skipped, not fatal */
        return false;
      }

    default:
      return false;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Get the current default patterns — for tests and admin inspection */
export function getDefaultPatterns(): readonly BlocklistPattern[] {
  return DEFAULT_PATTERNS;
}
