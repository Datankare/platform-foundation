/**
 * __tests__/contract/moderation-store-contract.ts
 * ModerationStore conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type { ModerationStore, ModerationAuditRecord } from "@/platform/moderation/types";

function makeRecord(
  overrides: Partial<ModerationAuditRecord> = {}
): ModerationAuditRecord {
  return {
    inputHash: "contract-hash",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    userId: "contract-user",
    triggeredBy: "none",
    categoriesFlagged: [],
    confidence: 1,
    severity: "low",
    actionTaken: "allow",
    reasoning: "contract test",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    classifierCostUsd: 0,
    trajectoryId: "traj-1",
    agentId: "agent-1",
    pipelineLatencyMs: 0,
    requestId: "req-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export interface ModerationStoreContractFixtures {
  makeStore: () => ModerationStore | Promise<ModerationStore>;
}

export function runModerationStoreContract(fx: ModerationStoreContractFixtures): void {
  let store: ModerationStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  describe("logAudit / queryAudits", () => {
    it("persists and returns a record by user", async () => {
      await store.logAudit(makeRecord({ userId: "u-contract" }));
      const results = await store.queryAudits({ userId: "u-contract" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.userId === "u-contract")).toBe(true);
    });

    it("respects a result limit", async () => {
      await store.logAudit(makeRecord({ requestId: "r1" }));
      await store.logAudit(makeRecord({ requestId: "r2" }));
      await store.logAudit(makeRecord({ requestId: "r3" }));
      const results = await store.queryAudits({ limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("getByInputHash", () => {
    it("returns records matching an input hash", async () => {
      await store.logAudit(makeRecord({ inputHash: "hash-xyz" }));
      const results = await store.getByInputHash("hash-xyz");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.inputHash === "hash-xyz")).toBe(true);
    });
  });
}
