/**
 * __tests__/moderation-audit.test.ts — Audit trail tests
 *
 * Tests: SHA-256 hashing, audit record building, privacy (no raw content).
 */

import { hashInput, buildAuditRecord } from "@/platform/moderation/audit";
import type { ModerationResult } from "@/platform/moderation/types";

// ---------------------------------------------------------------------------
// hashInput
// ---------------------------------------------------------------------------

describe("hashInput", () => {
  it("returns a 64-character hex string", async () => {
    const hash = await hashInput("Hello, world!");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns consistent hash for same input", async () => {
    const hash1 = await hashInput("test input");
    const hash2 = await hashInput("test input");
    expect(hash1).toBe(hash2);
  });

  it("returns different hash for different input", async () => {
    const hash1 = await hashInput("input A");
    const hash2 = await hashInput("input B");
    expect(hash1).not.toBe(hash2);
  });

  it("handles empty string", async () => {
    const hash = await hashInput("");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// buildAuditRecord
// ---------------------------------------------------------------------------

describe("buildAuditRecord", () => {
  const baseResult: ModerationResult = {
    action: "block",
    triggeredBy: "classifier",
    direction: "input",
    blocklistMatches: [],
    classifierOutput: {
      safe: false,
      categories: ["violence", "hate"],
      confidence: 0.87,
      severity: "high",
      reason: "graphic content",
    },
    pipelineLatencyMs: 250,
  };

  it("builds a complete audit record", async () => {
    const record = await buildAuditRecord("violent text", baseResult, "req-123");

    expect(record.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.direction).toBe("input");
    expect(record.triggeredBy).toBe("classifier");
    expect(record.categoriesFlagged).toEqual(["violence", "hate"]);
    expect(record.confidence).toBeCloseTo(0.87);
    expect(record.severity).toBe("high");
    expect(record.actionTaken).toBe("block");
    expect(record.pipelineLatencyMs).toBe(250);
    expect(record.requestId).toBe("req-123");
    expect(record.timestamp).toBeTruthy();
  });

  it("does NOT include raw text in the record", async () => {
    const record = await buildAuditRecord("secret sensitive text", baseResult, "req-456");
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain("secret sensitive text");
    expect(record.inputHash).toBeTruthy();
  });

  it("handles result without classifier output", async () => {
    const blocklistResult: ModerationResult = {
      action: "block",
      triggeredBy: "blocklist",
      direction: "input",
      blocklistMatches: ["kill yourself"],
      pipelineLatencyMs: 1,
    };

    const record = await buildAuditRecord("bad text", blocklistResult, "req-789");

    expect(record.categoriesFlagged).toEqual([]);
    expect(record.confidence).toBe(1.0);
    expect(record.severity).toBe("low");
  });

  it("records output direction", async () => {
    const outputResult: ModerationResult = {
      ...baseResult,
      direction: "output",
    };

    const record = await buildAuditRecord("AI output", outputResult, "req-out");

    expect(record.direction).toBe("output");
  });
});
