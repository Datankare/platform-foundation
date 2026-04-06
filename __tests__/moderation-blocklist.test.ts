/**
 * __tests__/moderation-blocklist.test.ts — Blocklist unit tests
 *
 * Tests: pattern matching (exact, substring, regex), severity ordering,
 * pattern validation (safe-regex2), pre-compilation, edge cases.
 */

import {
  scanBlocklist,
  getDefaultPatterns,
  validatePattern,
  compilePatterns,
} from "@/platform/moderation/blocklist";
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
// Pattern validation (B5: input validation)
// ---------------------------------------------------------------------------

describe("validatePattern", () => {
  it("accepts valid exact patterns", () => {
    const result = validatePattern({
      id: "t-1",
      pattern: "bad word",
      type: "exact",
      category: "hate",
      severity: "high",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts valid substring patterns", () => {
    const result = validatePattern({
      id: "t-2",
      pattern: "bad phrase",
      type: "substring",
      category: "hate",
      severity: "high",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts safe regex patterns", () => {
    const result = validatePattern({
      id: "t-3",
      pattern: "[a-z]+",
      type: "regex",
      category: "hate",
      severity: "high",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects ReDoS-vulnerable regex patterns (safe-regex2)", () => {
    const result = validatePattern({
      id: "t-4",
      pattern: "(a+)+b",
      type: "regex",
      category: "hate",
      severity: "high",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("safe-regex2");
  });

  it("rejects invalid regex syntax", () => {
    const result = validatePattern({
      id: "t-5",
      pattern: "[invalid(regex",
      type: "regex",
      category: "hate",
      severity: "high",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Invalid regex syntax");
  });

  it("rejects empty pattern string", () => {
    const result = validatePattern({
      id: "t-6",
      pattern: "",
      type: "exact",
      category: "hate",
      severity: "high",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("empty");
  });

  it("rejects empty pattern ID", () => {
    const result = validatePattern({
      id: "",
      pattern: "test",
      type: "exact",
      category: "hate",
      severity: "high",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("ID is empty");
  });
});

// ---------------------------------------------------------------------------
// Pre-compilation
// ---------------------------------------------------------------------------

describe("compilePatterns", () => {
  it("compiles valid patterns", () => {
    const compiled = compilePatterns([
      {
        id: "c-1",
        pattern: "bad",
        type: "substring",
        category: "hate",
        severity: "high",
      },
      {
        id: "c-2",
        pattern: "[0-9]+",
        type: "regex",
        category: "dangerous",
        severity: "medium",
      },
    ]);
    expect(compiled).toHaveLength(2);
  });

  it("rejects unsafe regex and keeps the rest (fail closed)", () => {
    const compiled = compilePatterns([
      {
        id: "safe-1",
        pattern: "good",
        type: "substring",
        category: "hate",
        severity: "low",
      },
      {
        id: "unsafe-1",
        pattern: "(a+)+b",
        type: "regex",
        category: "hate",
        severity: "high",
      },
      {
        id: "safe-2",
        pattern: "[a-z]+",
        type: "regex",
        category: "hate",
        severity: "medium",
      },
    ]);
    expect(compiled).toHaveLength(2);
    expect(compiled.map((c) => c.source.id)).toEqual(["safe-1", "safe-2"]);
  });

  it("returns empty array for all-invalid patterns", () => {
    const compiled = compilePatterns([
      { id: "", pattern: "", type: "exact", category: "hate", severity: "high" },
    ]);
    expect(compiled).toHaveLength(0);
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
// Scanning — regex patterns (validated safe)
// ---------------------------------------------------------------------------

describe("scanBlocklist — regex patterns", () => {
  const safeRegexPatterns: BlocklistPattern[] = [
    {
      id: "rx-1",
      pattern: "\\d{3}-\\d{3}-\\d{4}",
      type: "regex",
      category: "dangerous",
      severity: "medium",
    },
  ];

  it("matches safe regex patterns", () => {
    const result = scanBlocklist("Call me at 555-123-4567", safeRegexPatterns);
    expect(result.matched).toBe(true);
  });

  it("does not match when regex does not apply", () => {
    const result = scanBlocklist("no phone numbers here", safeRegexPatterns);
    expect(result.matched).toBe(false);
  });

  it("silently skips unsafe regex patterns (fail closed at compile time)", () => {
    const unsafePatterns: BlocklistPattern[] = [
      {
        id: "unsafe-1",
        pattern: "(a+)+b",
        type: "regex",
        category: "hate",
        severity: "high",
      },
    ];
    // Unsafe pattern is rejected during compilation — no match, no crash
    const result = scanBlocklist("aaaaaaaaab", unsafePatterns);
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
