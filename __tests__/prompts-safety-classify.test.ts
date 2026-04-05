/**
 * __tests__/prompts-safety-classify.test.ts — Safety classifier prompt tests
 *
 * Tests: prompt building, response parsing, edge cases, fail-closed behavior.
 * ADR-016: Structured classifier output.
 */

import { buildSafetyPrompt, parseClassifierResponse } from "@/prompts/safety/classify-v1";
import type { ClassifierOutput } from "@/prompts/safety/classify-v1";

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

describe("buildSafetyPrompt", () => {
  it("includes the sanitized text in the prompt", () => {
    const prompt = buildSafetyPrompt("Hello world");
    expect(prompt).toContain("Hello world");
    expect(prompt).toContain("content safety classifier");
  });

  it("includes all six category definitions", () => {
    const prompt = buildSafetyPrompt("test");
    expect(prompt).toContain('"harassment"');
    expect(prompt).toContain('"sexual"');
    expect(prompt).toContain('"violence"');
    expect(prompt).toContain('"self-harm"');
    expect(prompt).toContain('"hate"');
    expect(prompt).toContain('"dangerous"');
  });

  it("includes severity levels", () => {
    const prompt = buildSafetyPrompt("test");
    expect(prompt).toContain('"low"');
    expect(prompt).toContain('"medium"');
    expect(prompt).toContain('"high"');
    expect(prompt).toContain('"critical"');
  });

  it("mentions treating users as minors", () => {
    const prompt = buildSafetyPrompt("test");
    expect(prompt).toContain("minors");
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe("parseClassifierResponse", () => {
  it("parses a safe response", () => {
    const result = parseClassifierResponse(
      '{"safe": true, "categories": [], "confidence": 0.95, "severity": "low"}'
    );
    expect(result.safe).toBe(true);
    expect(result.categories).toEqual([]);
    expect(result.confidence).toBeCloseTo(0.95);
    expect(result.severity).toBe("low");
    expect(result.reason).toBeUndefined();
  });

  it("parses an unsafe response with categories", () => {
    const result = parseClassifierResponse(
      '{"safe": false, "categories": ["violence", "hate"], "confidence": 0.87, "severity": "high", "reason": "graphic violence"}'
    );
    expect(result.safe).toBe(false);
    expect(result.categories).toEqual(["violence", "hate"]);
    expect(result.confidence).toBeCloseTo(0.87);
    expect(result.severity).toBe("high");
    expect(result.reason).toBe("graphic violence");
  });

  it("handles markdown code fences", () => {
    const result = parseClassifierResponse(
      '```json\n{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}\n```'
    );
    expect(result.safe).toBe(true);
  });

  it("handles code fences without json tag", () => {
    const result = parseClassifierResponse(
      '```\n{"safe": true, "categories": [], "confidence": 0.9, "severity": "low"}\n```'
    );
    expect(result.safe).toBe(true);
  });

  it("clamps confidence to 0–1 range", () => {
    const over = parseClassifierResponse(
      '{"safe": true, "categories": [], "confidence": 1.5, "severity": "low"}'
    );
    expect(over.confidence).toBe(1.0);

    const under = parseClassifierResponse(
      '{"safe": true, "categories": [], "confidence": -0.5, "severity": "low"}'
    );
    expect(under.confidence).toBe(0.0);
  });

  it("filters invalid categories", () => {
    const result = parseClassifierResponse(
      '{"safe": false, "categories": ["violence", "invalid_cat", "hate"], "confidence": 0.8, "severity": "high"}'
    );
    expect(result.categories).toEqual(["violence", "hate"]);
  });

  it("defaults severity to medium if invalid", () => {
    const result = parseClassifierResponse(
      '{"safe": false, "categories": ["hate"], "confidence": 0.8, "severity": "extreme"}'
    );
    expect(result.severity).toBe("medium");
  });

  it("defaults confidence to 0.5 if missing", () => {
    const result = parseClassifierResponse(
      '{"safe": true, "categories": [], "severity": "low"}'
    );
    expect(result.confidence).toBe(0.5);
  });

  // Fail-closed behavior
  it("fails closed on invalid JSON", () => {
    const result = parseClassifierResponse("not json at all");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("medium");
    expect(result.reason).toContain("Failed to parse");
  });

  it("fails closed on empty string", () => {
    const result = parseClassifierResponse("");
    expect(result.safe).toBe(false);
  });

  it("fails closed on missing safe field", () => {
    const result = parseClassifierResponse(
      '{"categories": [], "confidence": 0.9, "severity": "low"}'
    );
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Missing 'safe' field");
  });

  it("handles null categories gracefully", () => {
    const result = parseClassifierResponse(
      '{"safe": true, "categories": null, "confidence": 0.9, "severity": "low"}'
    );
    expect(result.categories).toEqual([]);
  });

  it("handles non-string reason gracefully", () => {
    const result = parseClassifierResponse(
      '{"safe": false, "categories": ["hate"], "confidence": 0.9, "severity": "high", "reason": 123}'
    );
    expect(result.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Type validation — ClassifierOutput shape
// ---------------------------------------------------------------------------

describe("ClassifierOutput type contract", () => {
  it("has all required fields", () => {
    const output: ClassifierOutput = {
      safe: true,
      categories: [],
      confidence: 1.0,
      severity: "low",
    };
    expect(output).toBeDefined();
    expect(output.reason).toBeUndefined();
  });
});
