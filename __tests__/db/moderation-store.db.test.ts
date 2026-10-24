/**
 * @jest-environment node
 */
/**
 * PostgresModerationStore against the replayed database: the conformance kit inside one tenant
 * (each test a fresh tenant), the SQL paths the kit does not reach (every filter, the row
 * mapping, refused writes and failed reads), and the store isolated between tenants.
 */

jest.mock("@/platform/data", () => require("../helpers/data-faults").withFaults());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runModerationStoreContract } from "../contract/moderation-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { moderationAuditIsolation } from "../helpers/moderation-isolation-fixtures";
import { clearFaults, faults } from "../helpers/data-faults";
import { PostgresModerationStore } from "@/platform/moderation/store";
import type { ModerationAuditRecord } from "@/platform/moderation/types";
import { DataUnavailableError } from "@/platform/data";
import { logger } from "@/lib/logger";
import { runWithoutTenant } from "@/platform/tenancy/context";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
} from "../helpers/db";

function record(overrides: Partial<ModerationAuditRecord> = {}): ModerationAuditRecord {
  return {
    inputHash: "h-1",
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    userId: "user-1",
    triggeredBy: "none",
    categoriesFlagged: [],
    confidence: 1,
    severity: "low",
    actionTaken: "allow",
    reasoning: "db test",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    classifierCostUsd: 0,
    trajectoryId: "traj-1",
    agentId: "agent-1",
    pipelineLatencyMs: 0,
    requestId: "req-1",
    timestamp: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

dbDescribe("PostgresModerationStore", () => {
  beforeAll(connectTestDatabase);
  afterEach(() => {
    clearFaults();
    jest.clearAllMocks();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runModerationStoreContract({
    makeStore: async () =>
      inTenant(new PostgresModerationStore(), await createTestTenant()),
  });

  runTenantIsolationContract({
    name: "content_safety_audit",
    makeStore: () => new PostgresModerationStore(),
    createTenant: createTestTenant,
    ...moderationAuditIsolation(),
    // logAudit never throws (P11) and reads return nothing on failure: see "without a tenant".
    failsClosedWithoutTenant: false,
  });

  describe("SQL paths beyond the kit", () => {
    let store: PostgresModerationStore;
    beforeEach(async () => {
      store = inTenant(new PostgresModerationStore(), await createTestTenant());
    });

    it("round-trips every field, with ISO timestamps and parsed classifier output", async () => {
      const full = record({
        direction: "output",
        contentType: "social",
        contentRatingLevel: 2,
        triggeredBy: "classifier",
        classifierOutput: {
          safe: false,
          categories: ["harassment"],
          confidence: 0.75,
          severity: "medium",
        },
        categoriesFlagged: ["harassment"],
        confidence: 0.75,
        severity: "medium",
        actionTaken: "block",
        severityAdjustment: -1,
        contextFactors: ["quoted"],
        attributeToUser: false,
        classifierCostUsd: 0.0025,
        pipelineLatencyMs: 42,
      });
      await store.logAudit(full);
      expect(await store.getByInputHash("h-1")).toEqual([full]);
    });

    it("maps a record with no user and no classifier output", async () => {
      await store.logAudit(record({ userId: undefined, classifierOutput: undefined }));
      const [r] = await store.getByInputHash("h-1");
      expect(r.userId).toBeUndefined();
      expect(r.classifierOutput).toBeUndefined();
    });

    it("applies every filter, newest first, and the limit", async () => {
      await store.logAudit(
        record({ requestId: "a", timestamp: "2026-10-01T00:00:00.000Z" })
      );
      await store.logAudit(
        record({
          requestId: "b",
          actionTaken: "block",
          direction: "output",
          contentType: "social",
          contentRatingLevel: 3,
          userId: "user-2",
          trajectoryId: "traj-2",
          timestamp: "2026-10-03T00:00:00.000Z",
        })
      );
      await store.logAudit(
        record({ requestId: "c", timestamp: "2026-10-02T00:00:00.000Z" })
      );
      const ids = (rs: readonly ModerationAuditRecord[]) => rs.map((r) => r.requestId);

      expect(ids(await store.queryAudits())).toEqual(["b", "c", "a"]);
      expect(ids(await store.queryAudits({ actionTaken: "block" }))).toEqual(["b"]);
      expect(ids(await store.queryAudits({ direction: "output" }))).toEqual(["b"]);
      expect(ids(await store.queryAudits({ contentType: "social" }))).toEqual(["b"]);
      expect(ids(await store.queryAudits({ contentRatingLevel: 3 }))).toEqual(["b"]);
      expect(ids(await store.queryAudits({ userId: "user-2" }))).toEqual(["b"]);
      expect(ids(await store.queryAudits({ trajectoryId: "traj-2" }))).toEqual(["b"]);
      expect(ids(await store.queryAudits({ since: "2026-10-02T00:00:00.000Z" }))).toEqual(
        ["b", "c"]
      );
      expect(
        ids(await store.queryAudits({ before: "2026-10-02T00:00:00.000Z" }))
      ).toEqual(["a"]);
      expect(ids(await store.queryAudits({ limit: 1 }))).toEqual(["b"]);
      expect(ids(await store.queryAudits({ limit: 0 }))).toHaveLength(3);
    });

    it("logs, and does not throw, when the database refuses the record", async () => {
      // "unknown" is not a screening_direction: the insert is refused.
      await store.logAudit(
        record({ direction: "unknown" as ModerationAuditRecord["direction"] })
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Moderation store: persistence error",
        expect.objectContaining({ requestId: "req-1" })
      );
      expect(await store.getByInputHash("h-1")).toEqual([]);
    });

    it("returns nothing when a read fails", async () => {
      await store.logAudit(record());
      faults.fail = () => new DataUnavailableError("injected");
      expect(await store.queryAudits()).toEqual([]);
      expect(await store.getByInputHash("h-1")).toEqual([]);
    });

    it("returns nothing for a filter value the column cannot hold", async () => {
      await store.logAudit(record());
      expect(
        await store.queryAudits({
          actionTaken: "nope" as ModerationAuditRecord["actionTaken"],
        })
      ).toEqual([]);
    });
  });

  describe("without a tenant", () => {
    it("writes nothing and reads nothing, without throwing", async () => {
      const store = new PostgresModerationStore();
      await runWithoutTenant(async () => {
        await expect(store.logAudit(record({ inputHash: "no-tenant" }))).resolves.toBe(
          undefined
        );
        await expect(store.getByInputHash("no-tenant")).resolves.toEqual([]);
        await expect(store.queryAudits()).resolves.toEqual([]);
      });
      expect(logger.error).toHaveBeenCalledWith(
        "Moderation store: persistence error",
        expect.objectContaining({ error: expect.stringMatching(/tenant/i) })
      );
    });
  });
});
