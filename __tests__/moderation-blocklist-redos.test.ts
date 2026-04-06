/**
 * __tests__/moderation-blocklist-redos.test.ts
 *
 * Isolated test file for ReDoS pattern validation.
 *
 * These tests NECESSARILY contain unsafe regex patterns like (a+)+b
 * to verify that safe-regex2 correctly rejects them. CodeQL's js/redos
 * rule is excluded for this file only — all other test files remain
 * fully scanned.
 *
 * See: .github/workflows/codeql.yml paths-ignore
 */

import {
  scanBlocklist,
  validatePattern,
  compilePatterns,
} from "@/platform/moderation/blocklist";
import type { BlocklistPattern } from "@/platform/moderation/types";

// ---------------------------------------------------------------------------
// Validation: ReDoS rejection (safe-regex2)
// ---------------------------------------------------------------------------

describe("validatePattern — ReDoS detection", () => {
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
});

// ---------------------------------------------------------------------------
// Compilation: unsafe regex rejection
// ---------------------------------------------------------------------------

describe("compilePatterns — ReDoS rejection", () => {
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
});

// ---------------------------------------------------------------------------
// Scanning: unsafe regex silently skipped
// ---------------------------------------------------------------------------

describe("scanBlocklist — ReDoS rejection at compile time", () => {
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
