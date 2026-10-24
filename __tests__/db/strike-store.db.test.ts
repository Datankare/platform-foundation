/**
 * @jest-environment node
 */
/**
 * PostgresStrikeStore against the replayed database: the conformance kit inside one tenant
 * (each test a fresh tenant with its own two users — user_strikes names a user of the same
 * tenant), the SQL paths the kit does not reach (filters, the expiry sweep, refused writes, a
 * history that cannot be read), and the store isolated between tenants.
 */

jest.mock("@/platform/data", () => require("../helpers/data-faults").withFaults());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from "node:crypto";
import { runStrikeStoreContract } from "../contract/strike-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { strikeIsolation } from "../helpers/moderation-isolation-fixtures";
import { clearFaults, faults } from "../helpers/data-faults";
import { PostgresStrikeStore } from "@/platform/moderation/strikes";
import type { StrikeRecord } from "@/platform/moderation/types";
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

const DAY = 86_400_000;

/** Tenants by id, so a fixture can find the current tenant's user. */
const tenants = new Map<string, TestTenant>();
async function tenant(): Promise<TestTenant> {
  const t = await createTestTenant();
  tenants.set(t.id, t);
  return t;
}
/** A user of the current tenant (an unknown id outside any tenant). */
async function userFor(): Promise<string> {
  const t = tenants.get(peekTenant()?.tenantId ?? "");
  return t ? t.user("iso") : randomUUID();
}

function strike(
  userId: string,
  overrides: Partial<StrikeRecord> = {}
): Omit<StrikeRecord, "id" | "createdAt"> {
  return {
    userId,
    category: "harassment",
    severity: "medium",
    moderationAuditId: null,
    guardianDecisionId: "guardian-1",
    trajectoryId: "sentinel-1",
    agentId: "sentinel",
    reason: "db test",
    expiresAt: new Date(Date.now() + DAY).toISOString(),
    expired: false,
    ...overrides,
  };
}

dbDescribe("PostgresStrikeStore", () => {
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
    runStrikeStoreContract({
      makeStore: async () => {
        const t = await tenant();
        users = { a: await t.user("a"), b: await t.user("b") };
        return inTenant(new PostgresStrikeStore(), t);
      },
      users: () => users,
    });
  });

  runTenantIsolationContract({
    name: "user_strikes",
    makeStore: () => new PostgresStrikeStore(),
    createTenant: tenant,
    ...strikeIsolation(userFor),
    // recordStrike reports failure as a result, not a throw (L19): see "without a tenant".
    failsClosedWithoutTenant: false,
  });

  describe("SQL paths beyond the kit", () => {
    let t: TestTenant;
    let store: PostgresStrikeStore;
    let user: string;
    beforeEach(async () => {
      t = await tenant();
      store = inTenant(new PostgresStrikeStore(), t);
      user = await t.user("u");
    });

    it("round-trips every field with ISO timestamps", async () => {
      const auditId = randomUUID();
      const expiresAt = new Date(Date.now() + DAY).toISOString();
      const res = await store.recordStrike(
        strike(user, { moderationAuditId: auditId, severity: "high", expiresAt })
      );
      expect(res.success).toBe(true);
      const [read] = await store.getActiveStrikes(user);
      expect(read).toEqual(res.record);
      expect(read).toMatchObject({
        userId: user,
        moderationAuditId: auditId,
        guardianDecisionId: "guardian-1",
        severity: "high",
        expiresAt,
        expired: false,
      });
      expect(new Date(read.createdAt).toISOString()).toBe(read.createdAt);
    });

    it("refuses a strike for a user of no tenant it can see, and says why (L19)", async () => {
      const res = await store.recordStrike(strike(randomUUID()));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/foreign key/);
    });

    it("refuses a strike whose user id is not a uuid", async () => {
      const res = await store.recordStrike(strike("not-a-uuid"));
      expect(res).toMatchObject({ success: false, error: expect.any(String) });
    });

    it("fails closed when the history cannot be read: throws rather than reporting none", async () => {
      await store.recordStrike(strike(user));
      faults.fail = (sql) =>
        /from user_strikes/.test(sql) ? new DataUnavailableError("injected") : undefined;
      await expect(store.getActiveStrikes(user)).rejects.toThrow(/unreadable/);
      await expect(store.getStrikeSummary(user)).rejects.toThrow(/unreadable/);
    });

    it("queries by category and activity, newest first, 50 by default", async () => {
      await store.recordStrike(strike(user, { category: "spam" }));
      const second = await store.recordStrike(strike(user, { category: "harassment" }));
      await store.expireStrike(second.record!.id);
      await store.recordStrike(strike(user, { category: "spam", reason: "newest" }));

      const all = await store.queryStrikes({ userId: user });
      expect(all.map((s) => s.category)).toEqual(["spam", "harassment", "spam"]);
      expect(all[0].reason).toBe("newest");
      expect(await store.queryStrikes({ userId: user, activeOnly: true })).toHaveLength(
        2
      );
      expect(
        await store.queryStrikes({ userId: user, category: "harassment" })
      ).toHaveLength(1);
      expect(await store.queryStrikes({ userId: user, limit: 1 })).toHaveLength(1);

      for (let i = 0; i < 60; i++)
        await store.recordStrike(strike(user, { reason: `r${i}` }));
      expect(await store.queryStrikes({ userId: user })).toHaveLength(50);
    });

    it("returns no strikes when a query fails", async () => {
      expect(await store.queryStrikes({ userId: "not-a-uuid" })).toEqual([]);
    });

    it("sweeps only strikes past their expiry", async () => {
      await store.recordStrike(
        strike(user, { expiresAt: new Date(Date.now() - DAY).toISOString() })
      );
      await store.recordStrike(strike(user));
      await store.recordStrike(strike(user, { expiresAt: null }));
      expect(await store.expireStrikes()).toBe(1);
      expect(await store.expireStrikes()).toBe(0);
      const flagged = await store.queryStrikes({ userId: user, activeOnly: true });
      expect(flagged).toHaveLength(2);
    });

    it("reports 0 when the sweep fails, and false when one expiry fails", async () => {
      const res = await store.recordStrike(strike(user));
      faults.fail = (sql) =>
        /^update user_strikes/.test(sql)
          ? new DataUnavailableError("injected")
          : undefined;
      expect(await store.expireStrikes()).toBe(0);
      expect(await store.expireStrike(res.record!.id)).toBe(false);
      clearFaults();
      expect(await store.expireStrike("not-a-uuid")).toBe(false);
      expect(await store.expireStrike(randomUUID())).toBe(false);
    });
  });

  describe("without a tenant", () => {
    it("records nothing and throws on a history read", async () => {
      const store = new PostgresStrikeStore();
      const user = randomUUID();
      await runWithoutTenant(async () => {
        const res = await store.recordStrike(strike(user));
        expect(res).toMatchObject({
          success: false,
          error: expect.stringMatching(/tenant/i),
        });
        await expect(store.getActiveStrikes(user)).rejects.toThrow(/tenant/i);
        expect(await store.queryStrikes({ userId: user })).toEqual([]);
        expect(await store.expireStrikes()).toBe(0);
        expect(await store.expireStrike(randomUUID())).toBe(false);
      });
    });
  });
});
