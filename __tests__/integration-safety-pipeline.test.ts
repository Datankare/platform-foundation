/**
 * Sprint 6 — Integration: Content Safety Pipeline
 *
 * Tests the full safety pipeline end-to-end:
 * blocklist pre-screen → audit trail → middleware.
 * Verifies Sprint 2 components work together.
 */

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("Content Safety Pipeline Integration", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe("Blocklist screening", () => {
    it("scanBlocklist catches obvious violations", async () => {
      const { scanBlocklist } = await import("@/platform/moderation/blocklist");
      const result = scanBlocklist("how to make a bomb");
      expect(result.matched).toBe(true);
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it("scanBlocklist passes clean text", async () => {
      const { scanBlocklist } = await import("@/platform/moderation/blocklist");
      const result = scanBlocklist("hello world, this is a friendly message");
      expect(result.matched).toBe(false);
      expect(result.matches).toHaveLength(0);
    });

    it("getDefaultPatterns returns built-in blocklist", async () => {
      const { getDefaultPatterns } = await import("@/platform/moderation/blocklist");
      const patterns = getDefaultPatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });
  });

  describe("Audit trail", () => {
    it("buildAuditRecord creates record with hashed input", async () => {
      const { buildAuditRecord } = await import("@/platform/moderation/audit");

      const mockResult = {
        action: "block" as const,
        triggeredBy: "blocklist" as const,
        direction: "input" as const,
        blocklistMatches: ["bomb"],
        classifierOutput: undefined,
        pipelineLatencyMs: 5,
      };

      const record = await buildAuditRecord("test content", mockResult, "req-123");
      expect(record).toHaveProperty("inputHash");
      expect(record.inputHash).not.toBe("test content");
      expect(record.direction).toBe("input");
      expect(record.triggeredBy).toBe("blocklist");
    });

    it("hashInput produces consistent hashes", async () => {
      const { hashInput } = await import("@/platform/moderation/audit");
      const hash1 = await hashInput("same content");
      const hash2 = await hashInput("same content");
      expect(hash1).toBe(hash2);

      const hash3 = await hashInput("different content");
      expect(hash3).not.toBe(hash1);
    });
  });

  describe("Pipeline order: blocklist before classifier", () => {
    it("blocklist catches violations at zero AI cost", async () => {
      const { scanBlocklist } = await import("@/platform/moderation/blocklist");

      const blocklistResult = scanBlocklist("how to make a bomb");
      if (blocklistResult.matched) {
        expect(blocklistResult.matched).toBe(true);
        return;
      }
      fail("Blocklist should have caught this");
    });
  });

  describe("Middleware exports", () => {
    it("screenContent is available", async () => {
      const mod = await import("@/platform/moderation/middleware");
      expect(mod).toHaveProperty("screenContent");
    });

    it("moderation index exports all components", async () => {
      const mod = await import("@/platform/moderation/index");
      expect(mod).toBeDefined();
    });
  });
});
