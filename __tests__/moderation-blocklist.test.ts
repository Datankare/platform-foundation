/**
 * __tests__/moderation-blocklist.test.ts — Blocklist unit tests
 *
 * Tests: pattern matching (exact, substring, regex), severity ordering,
 * edge cases (empty input, no matches, multiple matches).
 */

import { scanBlocklist, getDefaultPatterns } from "@/platform/moderation/blocklist";
import type { BlocklistPattern } from "@/platform/moderation/types";

// ---------------------------------------------------------------------------
// Default patterns
// ---------------------------------------------------------------------------

describe("getDefaultPatterns", () => {
  it("returns a non-empty array", () => {
    const patterns = getDefaultPatterns();
    expect(patterns.length).toBeGreaterThan(0);
  });

  it("every pattern has required fields", () => {
    for (const p of getDefaultPatterns()) {
      expect(p.id).toBeTruthy();
      expect(p.pattern).toBeTruthy();
      expect(["exact", "substring", "regex"]).toContain(p.type);
      expect(p.category).toBeTruthy();
      expect(p.severity).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Scanning — substring matches
// ---------------------------------------------------------------------------

describe("scanBlocklist — substring patterns", () => {
  it("matches substring patterns case-insensitively", () => {
    const result = scanBlocklist("I want to know how to make a bomb");
    expect(result.matched).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].category).toBe("dangerous");
  });

  it("matches regardless of case", () => {
    const result = scanBlocklist("HOW TO MAKE A BOMB please");
    expect(result.matched).toBe(true);
  });

  it("does not match partial substring", () => {
    const result = scanBlocklist("I like making bombastic meals");
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scanning — exact word-boundary matches
// ---------------------------------------------------------------------------

describe("scanBlocklist — exact patterns", () => {
  it("matches exact word pattern", () => {
    const result = scanBlocklist("just kys already");
    expect(result.matched).toBe(true);
    expect(result.matches[0].category).toBe("self-harm");
  });

  it("does not match exact pattern inside another word", () => {
    const result = scanBlocklist("I need my keys");
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scanning — regex patterns
// ---------------------------------------------------------------------------

describe("scanBlocklist — regex patterns", () => {
  const regexPatterns: BlocklistPattern[] = [
    {
      id: "rx-1",
      pattern: "\\b\\d{3}-\\d{3}-\\d{4}\\b",
      type: "regex",
      category: "dangerous",
      severity: "medium",
    },
  ];

  it("matches regex patterns", () => {
    const result = scanBlocklist("Call me at 555-123-4567", regexPatterns);
    expect(result.matched).toBe(true);
  });

  it("skips invalid regex without crashing", () => {
    const badPatterns: BlocklistPattern[] = [
      {
        id: "bad-1",
        pattern: "[invalid(regex",
        type: "regex",
        category: "dangerous",
        severity: "low",
      },
    ];
    const result = scanBlocklist("test text", badPatterns);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

describe("scanBlocklist — severity", () => {
  it("returns the highest severity when multiple patterns match", () => {
    const patterns: BlocklistPattern[] = [
      { id: "t-1", pattern: "bad", type: "substring", category: "hate", severity: "low" },
      {
        id: "t-2",
        pattern: "very bad",
        type: "substring",
        category: "hate",
        severity: "critical",
      },
    ];
    const result = scanBlocklist("this is very bad content", patterns);
    expect(result.matched).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.maxSeverity).toBe("critical");
  });

  it("returns low severity for no matches", () => {
    const result = scanBlocklist("perfectly fine text");
    expect(result.matched).toBe(false);
    expect(result.maxSeverity).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("scanBlocklist — edge cases", () => {
  it("handles empty string", () => {
    const result = scanBlocklist("");
    expect(result.matched).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("handles whitespace-only string", () => {
    const result = scanBlocklist("   ");
    expect(result.matched).toBe(false);
  });

  it("handles empty patterns array", () => {
    const result = scanBlocklist("any text", []);
    expect(result.matched).toBe(false);
  });

  it("returns all matching patterns, not just the first", () => {
    const result = scanBlocklist("kill yourself during a school shooting");
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
  });
});
