/**
 * @jest-environment node
 */
/**
 * PostgresReviewQueueStore against the replayed database: the conformance kit inside one
 * tenant (each test a fresh tenant with its own two users — review_queue names a user of the
 * same tenant), the SQL paths the kit does not reach (row mapping, every filter, partial
 * updates, refusals and failed reads), and the store isolated between tenants.
 */

jest.mock("@/platform/data", () => require("../helpers/data-faults").withFaults());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from "node:crypto";
import { runReviewQueueStoreContract } from "../contract/review-queue-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { reviewQueueIsolation } from "../helpers/moderation-isolation-fixtures";
import { clearFaults, faults } from "../helpers/data-faults";
import { PostgresReviewQueueStore } from "@/platform/moderation/review-store";
import type { ReviewQueueItem } from "@/platform/moderation/review-types";
import { DataUnavailableError } from "@/platform/data";
import { peekTenant, runWithoutTenant } from "@/platform/tenancy/context";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

const tenants = new Map<string, TestTenant>();
async function tenant(): Promise<TestTenant> {
  const t = await createTestTenant();
  tenants.set(t.id, t);
  return t;
}
async function userFor(): Promise<string> {
  const t = tenants.get(peekTenant()?.tenantId ?? "");
  return t ? t.user("iso") : randomUUID();
}

type NewItem = Omit<ReviewQueueItem, "id" | "createdAt" | "updatedAt">;

function item(targetUserId: string, overrides: Partial<NewItem> = {}): NewItem {
  return {
    source: "escalation",
    priority: "high",
    status: "pending",
    moderationResult: {
      action: "escalate",
      triggeredBy: "classifier",
      direction: "input",
      contentType: "generation",
      contentRatingLevel: 1,
      blocklistMatches: [],
      reasoning: "db test",
      severityAdjustment: 0,
      contextFactors: [],
      attributeToUser: true,
      pipelineLatencyMs: 1,
      classifierCostUsd: 0,
      trajectoryId: "guardian-1",
      agentId: "guardian",
    },
    targetUserId,
    requestId: "req-1",
    ...overrides,
  };
}

dbDescribe("PostgresReviewQueueStore", () => {
  beforeAll(connectTestDatabase);
  afterEach(() => {
    clearFaults();
    jest.clearAllMocks();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  describe("conformance", () => {
    let users = { a: "", b: "" };
    runReviewQueueStoreContract({
      makeStore: async () => {
        const t = await tenant();
        users = { a: await t.user("a"), b: await t.user("b") };
        return inTenant(new PostgresReviewQueueStore(), t);
      },
      users: () => users,
    });
  });

  runTenantIsolationContract({
    name: "review_queue",
    makeStore: () => new PostgresReviewQueueStore(),
    createTenant: tenant,
    ...reviewQueueIsolation(userFor),
    // Reads return nothing on failure (P11) and submit reports failure: see "without a tenant".
    failsClosedWithoutTenant: false,
  });

  describe("SQL paths beyond the kit", () => {
    let store: PostgresReviewQueueStore;
    let user: string;
    beforeEach(async () => {
      const t = await tenant();
      store = inTenant(new PostgresReviewQueueStore(), t);
      user = await t.user("u");
    });

    it("round-trips every field, jsonb parsed and timestamps ISO", async () => {
      const claimedAt = "2026-10-01T01:00:00.000Z";
      const resolvedAt = "2026-10-01T02:00:00.000Z";
      const full = item(user, {
        source: "appeal",
        priority: "normal",
        status: "resolved",
        explanationChain: {
          steps: [{ kind: "retrieval", detail: "x" }],
        } as unknown as ReviewQueueItem["explanationChain"],
        appealReason: "I was quoting a book for a class assignment.",
        originalDecisionId: "decision-9",
        claimedBy: "reviewer-1",
        claimedAt,
        resolvedBy: "reviewer-1",
        resolvedAt,
        decision: "modify",
        reviewerNotes: "lowered",
        modifiedAction: "warn",
        previousAccountStatus: "warned",
        relatedStrikeId: "strike-1",
      });
      const res = await store.submit(full);
      expect(res.success).toBe(true);
      const read = await store.getById(res.item!.id);
      expect(read).toEqual(res.item);
      expect(read).toMatchObject({ ...full, claimedAt, resolvedAt });
      expect(new Date(read!.createdAt).toISOString()).toBe(read!.createdAt);
    });

    it("maps absent optional fields to undefined", async () => {
      const res = await store.submit(item(user));
      const read = await store.getById(res.item!.id);
      for (const k of [
        "explanationChain",
        "appealReason",
        "originalDecisionId",
        "claimedBy",
        "claimedAt",
        "resolvedBy",
        "resolvedAt",
        "decision",
        "reviewerNotes",
        "modifiedAction",
        "previousAccountStatus",
        "relatedStrikeId",
      ] as const) {
        expect(read![k]).toBeUndefined();
      }
    });

    it("refuses an item about a user it cannot see, with internal.error", async () => {
      const res = await store.submit(item(randomUUID()));
      expect(res).toMatchObject({ success: false, errorCode: "internal.error" });
    });

    it("returns nothing for an unknown or malformed id, or when the read fails", async () => {
      const { item: created } = await store.submit(item(user));
      expect(await store.getById("not-a-uuid")).toBeUndefined();
      faults.fail = () => new DataUnavailableError("injected");
      expect(await store.getById(created!.id)).toBeUndefined();
      expect(await store.getByOriginalDecisionId("decision-1")).toBeUndefined();
      expect(await store.query()).toEqual([]);
      await expect(store.releaseExpiredClaims(0)).rejects.toThrow(DataUnavailableError);
      const stats = await store.getStats();
      expect(stats.pendingCount).toBe(0);
    });

    it("finds only an open appeal by decision — not an escalation, not a resolved one", async () => {
      await store.submit(item(user, { originalDecisionId: "d-1" }));
      expect(await store.getByOriginalDecisionId("d-1")).toBeUndefined();
      const { item: appeal } = await store.submit(
        item(user, { source: "appeal", originalDecisionId: "d-1", status: "claimed" })
      );
      expect((await store.getByOriginalDecisionId("d-1"))?.id).toBe(appeal!.id);
    });

    it("updates only the fields given; the rest keep their values", async () => {
      const { item: created } = await store.submit(item(user));
      await store.update(created!.id, {
        status: "claimed",
        claimedBy: "r-1",
        claimedAt: "2026-10-01T00:00:00.000Z",
      });
      const res = await store.update(created!.id, {
        status: "resolved",
        resolvedBy: "r-1",
        resolvedAt: "2026-10-01T03:00:00.000Z",
        decision: "modify",
        reviewerNotes: "notes",
        modifiedAction: "block",
        priority: "critical",
        updatedAt: "2026-10-01T03:00:00.000Z",
      });
      expect(res.success).toBe(true);
      expect(res.item).toMatchObject({
        status: "resolved",
        claimedBy: "r-1",
        claimedAt: "2026-10-01T00:00:00.000Z",
        resolvedBy: "r-1",
        resolvedAt: "2026-10-01T03:00:00.000Z",
        decision: "modify",
        reviewerNotes: "notes",
        modifiedAction: "block",
        priority: "critical",
      });
      // Undefined is "leave as is", as the REST store's patch dropped it.
      const kept = await store.update(created!.id, { claimedBy: undefined });
      expect(kept.item?.claimedBy).toBe("r-1");
    });

    it("reports an update of an unknown or malformed id as a failure", async () => {
      expect(await store.update(randomUUID(), { status: "claimed" })).toMatchObject({
        success: false,
        errorCode: "moderation.review_item_not_found",
      });
      expect(await store.update("not-a-uuid", { status: "claimed" })).toMatchObject({
        success: false,
        errorCode: "internal.error",
      });
    });

    it("applies every query filter, oldest first, and the limit", async () => {
      const t0 = Date.now();
      await store.submit(item(user, { requestId: "a" }));
      const { item: b } = await store.submit(
        item(user, { requestId: "b", source: "appeal", priority: "normal" })
      );
      await store.update(b!.id, { status: "claimed", claimedBy: "r-9" });
      const ids = (rs: readonly ReviewQueueItem[]) => rs.map((r) => r.requestId);

      expect(ids(await store.query())).toEqual(["a", "b"]);
      expect(ids(await store.query({ status: "claimed" }))).toEqual(["b"]);
      expect(ids(await store.query({ source: "appeal" }))).toEqual(["b"]);
      expect(ids(await store.query({ priority: "high" }))).toEqual(["a"]);
      expect(ids(await store.query({ targetUserId: user }))).toEqual(["a", "b"]);
      expect(ids(await store.query({ claimedBy: "r-9" }))).toEqual(["b"]);
      expect(ids(await store.query({ limit: 1 }))).toEqual(["a"]);
      expect(ids(await store.query({ limit: 0 }))).toEqual(["a", "b"]);
      const hour = (n: number) => new Date(t0 + n * 3_600_000).toISOString();
      expect(ids(await store.query({ since: hour(-1) }))).toEqual(["a", "b"]);
      expect(ids(await store.query({ since: hour(1) }))).toEqual([]);
      expect(ids(await store.query({ before: hour(1) }))).toEqual(["a", "b"]);
      expect(ids(await store.query({ before: hour(-1) }))).toEqual([]);
    });

    it("builds stats from the tenant's items", async () => {
      const { item: done } = await store.submit(item(user));
      await store.submit(item(user, { source: "appeal", priority: "normal" }));
      const { item: claimed } = await store.submit(item(user));
      await store.update(claimed!.id, { status: "claimed" });
      await store.update(done!.id, {
        status: "resolved",
        resolvedAt: new Date(Date.now() + 1000).toISOString(),
      });
      const stats = await store.getStats();
      expect(stats).toMatchObject({
        pendingCount: 1,
        claimedCount: 1,
        resolvedCount: 1,
        pendingBySource: { escalation: 0, ban_review: 0, appeal: 1 },
      });
      expect(stats.avgResolutionMs).toBeGreaterThan(0);
    });
  });

  describe("without a tenant", () => {
    it("submits nothing and reads nothing", async () => {
      const store = new PostgresReviewQueueStore();
      await runWithoutTenant(async () => {
        const res = await store.submit(item(randomUUID()));
        expect(res).toMatchObject({
          success: false,
          error: expect.stringMatching(/tenant/i),
        });
        expect(await store.getById(randomUUID())).toBeUndefined();
        expect(await store.query()).toEqual([]);
        expect(await store.update(randomUUID(), { status: "claimed" })).toMatchObject({
          success: false,
        });
      });
    });
  });
});
