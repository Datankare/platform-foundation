/**
 * __tests__/moderation-audit.test.ts — Audit trail tests
 *
 * Tests: SHA-256 hashing, audit record building with rich fields,
 * privacy (no raw content), dual-write to store, resilient on store failure.
 */

import {
  hashInput,
  buildAuditRecord,
  logModerationAudit,
} from "@/platform/moderation/audit";
import {
  InMemoryModerationStore,
  setModerationStore,
  resetModerationStore,
} from "@/platform/moderation/store";
import type { ModerationResult } from "@/platform/moderation/types";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "mock-req-id",
}));

afterEach(() => {
  resetModerationStore();
  jest.clearAllMocks();
});

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
    triggeredBy: "content-rating",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    classifierOutput: {
      safe: false,
      categories: ["violence", "hate"],
      confidence: 0.87,
      severity: "high",
      reason: "graphic content",
    },
    reasoning: "Severity high >= block threshold medium for child (under 13).",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 250,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-abc",
    agentId: "guardian-xyz",
  };

  it("builds a complete audit record with all fields", async () => {
    const record = await buildAuditRecord("violent text", baseResult, "req-123");

    expect(record.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.direction).toBe("input");
    expect(record.contentType).toBe("generation");
    expect(record.contentRatingLevel).toBe(1);
    expect(record.triggeredBy).toBe("content-rating");
    expect(record.categoriesFlagged).toEqual(["violence", "hate"]);
    expect(record.confidence).toBeCloseTo(0.87);
    expect(record.severity).toBe("high");
    expect(record.actionTaken).toBe("block");
    expect(record.reasoning).toContain("block threshold");
    expect(record.severityAdjustment).toBe(0);
    expect(record.attributeToUser).toBe(true);
    expect(record.trajectoryId).toBe("traj-abc");
    expect(record.agentId).toBe("guardian-xyz");
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
      contentType: "generation",
      contentRatingLevel: 2,
      blocklistMatches: ["kill yourself"],
      reasoning: "Blocklist hit.",
      severityAdjustment: 0,
      contextFactors: [],
      attributeToUser: true,
      pipelineLatencyMs: 1,
      classifierCostUsd: 0,
      trajectoryId: "traj-bl",
      agentId: "guardian-bl",
    };

    const record = await buildAuditRecord("bad text", blocklistResult, "req-789");

    expect(record.categoriesFlagged).toEqual([]);
    expect(record.confidence).toBe(1.0);
    expect(record.severity).toBe("low");
    expect(record.contentRatingLevel).toBe(2);
  });

  it("records translation content type and severity adjustment", async () => {
    const translationResult: ModerationResult = {
      ...baseResult,
      contentType: "translation",
      severityAdjustment: -1,
      contextFactors: ["translation-content: severity reduced by 1"],
    };

    const record = await buildAuditRecord("translated text", translationResult, "req-tr");

    expect(record.contentType).toBe("translation");
    expect(record.severityAdjustment).toBe(-1);
    expect(record.contextFactors).toEqual(
      expect.arrayContaining([expect.stringContaining("translation-content")])
    );
  });

  it("records ai-output with attributeToUser=false", async () => {
    const aiResult: ModerationResult = {
      ...baseResult,
      contentType: "ai-output",
      direction: "output",
      attributeToUser: false,
    };

    const record = await buildAuditRecord("AI output", aiResult, "req-ai");

    expect(record.contentType).toBe("ai-output");
    expect(record.attributeToUser).toBe(false);
    expect(record.direction).toBe("output");
  });
});

// ---------------------------------------------------------------------------
// logModerationAudit — dual write
// ---------------------------------------------------------------------------

describe("logModerationAudit", () => {
  const result: ModerationResult = {
    action: "block",
    triggeredBy: "content-rating",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    blocklistMatches: [],
    classifierOutput: {
      safe: false,
      categories: ["violence"],
      confidence: 0.9,
      severity: "high",
    },
    reasoning: "Blocked per content rating.",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 100,
    classifierCostUsd: 0,
    trajectoryId: "traj-dual",
    agentId: "guardian-dual",
  };

  it("writes to both logger and store", async () => {
    const store = new InMemoryModerationStore();
    setModerationStore(store);

    await logModerationAudit("test text", result, "req-dual");

    expect(store.getRecordCount()).toBe(1);
    const records = await store.queryAudits();
    expect(records[0].actionTaken).toBe("block");
    expect(records[0].trajectoryId).toBe("traj-dual");

    const { logger } = jest.requireMock("@/lib/logger");
    expect(logger.info).toHaveBeenCalledWith(
      "moderation_audit",
      expect.objectContaining({
        requestId: "req-dual",
        actionTaken: "block",
        contentType: "generation",
        trajectoryId: "traj-dual",
        agentId: "guardian-dual",
      })
    );
  });

  it("continues when store throws (P11)", async () => {
    const failingStore = new InMemoryModerationStore();
    failingStore.logAudit = jest.fn().mockRejectedValue(new Error("DB down"));
    setModerationStore(failingStore);

    await expect(
      logModerationAudit("safe text", result, "req-fail")
    ).resolves.toBeUndefined();

    const { logger } = jest.requireMock("@/lib/logger");
    expect(logger.info).toHaveBeenCalledWith(
      "moderation_audit",
      expect.objectContaining({ requestId: "req-fail" })
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Moderation audit store write failed — logger write succeeded",
      expect.objectContaining({ requestId: "req-fail" })
    );
  });
});
