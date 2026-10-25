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

  // Review 8 H-B: a field missing or invalid is not a judgement — the answer is unjudged (and
  // never "safe"), so no threshold can clear it on a placeholder.
  it("a confidence outside 0–1 is unjudged (no clamping into a judgement)", () => {
    for (const c of ["1.5", "-0.5", '"0.9"', "null"]) {
      const r = parseClassifierResponse(
        `{"safe": true, "categories": [], "confidence": ${c}, "severity": "low"}`
      );
      expect([c, r.unjudged, r.safe]).toEqual([c, true, false]);
    }
  });

  it("an unknown category is unjudged (the known ones are kept for the record)", () => {
    const result = parseClassifierResponse(
      '{"safe": false, "categories": ["violence", "invalid_cat", "hate"], "confidence": 0.8, "severity": "high"}'
    );
    expect(result.categories).toEqual(["violence", "hate"]);
    expect(result.unjudged).toBe(true);
  });

  it("a severity not exactly one of the four is unjudged (placeholder medium)", () => {
    for (const sev of ['"extreme"', '"High"', '"severe"', "3", "null"]) {
      const result = parseClassifierResponse(
        `{"safe": false, "categories": ["hate"], "confidence": 0.8, "severity": ${sev}}`
      );
      expect([sev, result.severity, result.unjudged]).toEqual([sev, "medium", true]);
    }
  });

  it("a missing confidence or severity is unjudged, safe or not", () => {
    for (const raw of [
      '{"safe": true, "categories": [], "severity": "low"}',
      '{"safe": false, "categories": ["hate"], "severity": "high"}',
      '{"safe": false, "categories": ["hate"], "confidence": 0.9}',
      '{"safe": false}',
    ]) {
      const r = parseClassifierResponse(raw);
      expect([raw, r.unjudged, r.safe]).toEqual([raw, true, false]);
    }
  });

  it("a self-contradicting 'safe' (categories, or severity above low) is unjudged", () => {
    for (const raw of [
      '{"safe": true, "categories": ["hate"], "confidence": 0.9, "severity": "low"}',
      '{"safe": true, "categories": [], "confidence": 0.9, "severity": "high"}',
    ])
      expect(parseClassifierResponse(raw)).toMatchObject({ safe: false, unjudged: true });
  });

  it("a complete answer is a judgement", () => {
    expect(
      parseClassifierResponse(
        '{"safe": false, "categories": ["hate"], "confidence": 0.9, "severity": "high", "reason": "r"}'
      )
    ).toEqual({
      safe: false,
      categories: ["hate"],
      confidence: 0.9,
      severity: "high",
      reason: "r",
    });
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

  it("null categories are unjudged", () => {
    const result = parseClassifierResponse(
      '{"safe": true, "categories": null, "confidence": 0.9, "severity": "low"}'
    );
    expect(result.categories).toEqual([]);
    expect(result).toMatchObject({ safe: false, unjudged: true });
  });

  it("a reason that is not text is unjudged", () => {
    const result = parseClassifierResponse(
      '{"safe": false, "categories": ["hate"], "confidence": 0.9, "severity": "high", "reason": 123}'
    );
    expect(result.unjudged).toBe(true);
    expect(result.reason).toContain("reason is not text");
  });

  it("an answer that is not an object fails closed", () => {
    for (const raw of ["[]", "true", "null", '"safe"'])
      expect(parseClassifierResponse(raw)).toMatchObject({ safe: false, unjudged: true });
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
