/**
 * platform/moderation/blocklist.ts — Keyword/pattern pre-screen
 *
 * ADR-016: Layer 1 of multi-layer defense. Instant, zero-cost.
 * Catches known bad patterns before invoking the LLM classifier.
 *
 * Design:
 * - Patterns are validated with safe-regex2 at compile time (B5: input validation)
 * - Regex patterns are pre-compiled into RegExp objects at load time, not scan time
 * - Unsafe/invalid patterns are rejected and logged (A7: fail closed)
 * - Scan is synchronous and fast (< 1ms for the default set)
 * - Supports exact match, substring, and regex (validated safe)
 * - Future: load patterns from database for admin-editable blocklist
 */

import safeRegex from "safe-regex2";
import type { BlocklistPattern } from "./types";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Default patterns — common obvious violations
// ---------------------------------------------------------------------------

const DEFAULT_PATTERNS: BlocklistPattern[] = [
  // Hate speech / slurs — exact word-boundary matches
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
// Pattern validation (B5: preconditions asserted before execution)
// ---------------------------------------------------------------------------

export interface PatternValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a blocklist pattern BEFORE it can be used.
 * - Regex patterns are checked with safe-regex2 for ReDoS vulnerability
 * - Invalid regex syntax is rejected
 * - Empty patterns are rejected
 *
 * Public: used by tests, admin UI, and the compile step.
 */
export function validatePattern(pattern: BlocklistPattern): PatternValidation {
  if (!pattern.pattern || pattern.pattern.trim().length === 0) {
    return { valid: false, reason: "Pattern string is empty" };
  }

  if (!pattern.id || pattern.id.trim().length === 0) {
    return { valid: false, reason: "Pattern ID is empty" };
  }

  if (pattern.type === "regex") {
    // Step 1: Can it construct a valid RegExp?
    try {
      new RegExp(pattern.pattern, "i");
    } catch {
      /* justified — validation step, not execution */
      return { valid: false, reason: `Invalid regex syntax: ${pattern.pattern}` };
    }

    // Step 2: Is it safe from ReDoS? (safe-regex2)
    if (!safeRegex(pattern.pattern)) {
      return {
        valid: false,
        reason: `Regex rejected by safe-regex2 (potential ReDoS): ${pattern.pattern}`,
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Pre-compiled pattern cache (compile once at load, scan many times)
// ---------------------------------------------------------------------------

interface CompiledPattern {
  source: BlocklistPattern;
  /** Pre-compiled RegExp for regex type; null for exact/substring */
  compiled: RegExp | null;
}

/**
 * Compile and validate a set of patterns.
 * Invalid/unsafe patterns are rejected with a warning — fail closed (A7).
 * Returns only the patterns that passed validation.
 */
export function compilePatterns(patterns: BlocklistPattern[]): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];

  for (const pattern of patterns) {
    const validation = validatePattern(pattern);

    if (!validation.valid) {
      // Fail closed: reject the pattern, log the reason (A7, B6)
      logger.warn("Blocklist pattern rejected", {
        patternId: pattern.id,
        reason: validation.reason,
        route: "platform/moderation/blocklist",
      });
      continue;
    }

    if (pattern.type === "regex") {
      // Pre-compile — validated safe by validatePattern above
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      // Pattern validated by safe-regex2 against ReDoS before construction.
      compiled.push({ source: pattern, compiled: new RegExp(pattern.pattern, "i") });
    } else {
      compiled.push({ source: pattern, compiled: null });
    }
  }

  return compiled;
}

// Pre-compile default patterns at module load time
let compiledDefaults: CompiledPattern[] = compilePatterns(DEFAULT_PATTERNS);

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
 *
 * If custom patterns are provided, they are compiled and validated
 * on every call. For production use, prefer compilePatterns() + the
 * default set.
 */
export function scanBlocklist(
  text: string,
  patterns?: BlocklistPattern[]
): BlocklistResult {
  const active = patterns ? compilePatterns(patterns) : compiledDefaults;
  const normalized = text.toLowerCase().trim();
  const matches: BlocklistMatch[] = [];

  for (const entry of active) {
    const isMatch = matchCompiled(normalized, entry);
    if (isMatch) {
      matches.push({
        patternId: entry.source.id,
        matched: entry.source.pattern,
        category: entry.source.category,
        severity: entry.source.severity,
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

function matchCompiled(text: string, entry: CompiledPattern): boolean {
  const normalizedPattern = entry.source.pattern.toLowerCase();

  switch (entry.source.type) {
    case "exact":
      return matchExactWord(text, normalizedPattern);

    case "substring":
      return text.includes(normalizedPattern);

    case "regex":
      // Pre-compiled and validated safe — just execute
      return entry.compiled !== null && entry.compiled.test(text);

    default:
      return false;
  }
}

/**
 * String-based word boundary match — no dynamic RegExp needed.
 * Checks that the pattern appears surrounded by non-word characters
 * (or at the start/end of the string).
 */
function matchExactWord(text: string, word: string): boolean {
  let startIndex = 0;
  // B2: loop bounded by text length — indexOf advances startIndex each iteration
  while (startIndex <= text.length) {
    const idx = text.indexOf(word, startIndex);
    if (idx === -1) return false;

    const charBefore = idx === 0 ? " " : text[idx - 1];
    const charAfter = idx + word.length >= text.length ? " " : text[idx + word.length];

    if (!isWordChar(charBefore) && !isWordChar(charAfter)) return true;

    startIndex = idx + 1;
  }
  return false;
}

function isWordChar(ch: string): boolean {
  return /\w/.test(ch);
}

/** Get the current default patterns — for tests and admin inspection */
export function getDefaultPatterns(): readonly BlocklistPattern[] {
  return DEFAULT_PATTERNS;
}

/**
 * Replace compiled defaults — used in tests to reset state.
 */
export function resetCompiledDefaults(): void {
  compiledDefaults = compilePatterns(DEFAULT_PATTERNS);
}
