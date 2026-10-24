/**
 * @jest-environment node
 */
/**
 * PostgresEffectLedger against the replayed database: the conformance kit inside one tenant,
 * the SQL paths the kit does not reach (concurrent begin, receipts, the database's checks),
 * and the ledger isolated between tenants.
 */

import { runEffectLedgerContract } from "../contract/effect-ledger-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { effectLedgerIsolation } from "../helpers/store-isolation-fixtures";
import { PostgresEffectLedger } from "@/platform/agents/postgres-effect-ledger";
import { withTenantTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

dbDescribe("PostgresEffectLedger", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runEffectLedgerContract({
    makeLedger: async () =>
      inTenant(new PostgresEffectLedger(), await createTestTenant()),
  });

  describe("SQL paths beyond the kit", () => {
    let tenant: TestTenant;
    let ledger: PostgresEffectLedger;
    beforeEach(async () => {
      tenant = await createTestTenant();
      ledger = inTenant(new PostgresEffectLedger(), tenant);
    });

    it("concurrent begins make one entry, counting every attempt", async () => {
      const args = {
        operationId: "op",
        effectKey: "k",
        effectType: "sendMessage" as const,
      };
      const all = await Promise.all(Array.from({ length: 5 }, () => ledger.begin(args)));
      expect(new Set(all.map((e) => e.entryId)).size).toBe(1);
      expect((await ledger.get("op", "k"))?.attempts).toBe(5);
    });

    it("a retry keeps the first request", async () => {
      const args = {
        operationId: "op",
        effectKey: "k",
        effectType: "externalCall" as const,
      };
      await ledger.begin({ ...args, request: { amount: 1 } });
      const again = await ledger.begin({ ...args, request: { amount: 2 } });
      expect(again.request).toEqual({ amount: 1 });
    });

    it("stores a receipt or an error on resolution, with an ISO resolvedAt", async () => {
      await ledger.begin({
        operationId: "a",
        effectKey: "k",
        effectType: "externalCall",
      });
      await ledger.begin({
        operationId: "b",
        effectKey: "k",
        effectType: "externalCall",
      });
      const ok = await ledger.resolve("a", "k", "confirmed", { receipt: { id: "r1" } });
      expect(ok?.receipt).toEqual({ id: "r1" });
      expect(ok?.error).toBeUndefined();
      expect(new Date(ok!.resolvedAt!).toISOString()).toBe(ok!.resolvedAt);
      const bad = await ledger.resolve("b", "k", "failed", { error: "declined" });
      expect(bad?.error).toBe("declined");
      expect(bad?.receipt).toBeUndefined();
    });

    it("lists pending and indeterminate entries oldest first, limited", async () => {
      await ledger.begin({
        operationId: "o1",
        effectKey: "k",
        effectType: "externalCall",
      });
      await ledger.begin({
        operationId: "o2",
        effectKey: "k",
        effectType: "externalCall",
      });
      await ledger.begin({
        operationId: "o3",
        effectKey: "k",
        effectType: "externalCall",
      });
      await ledger.resolve("o2", "k", "indeterminate");
      await ledger.resolve("o3", "k", "confirmed");
      const all = await ledger.listUnresolved();
      expect(all.map((e) => e.operationId)).toEqual(["o1", "o2"]);
      expect((await ledger.listUnresolved(1)).map((e) => e.operationId)).toEqual(["o1"]);
    });

    it("reads a non-object request as empty", async () => {
      await ledger.begin({
        operationId: "r",
        effectKey: "k",
        effectType: "externalCall",
      });
      await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            "update effect_ledger set request = '\"x\"'::jsonb where operation_id = 'r'"
          )
        )
      );
      expect((await ledger.get("r", "k"))?.request).toEqual({});
    });

    it("propagates a database refusal (unknown effect type) as a thrown error", async () => {
      await expect(
        ledger.begin({
          operationId: "x",
          effectKey: "k",
          effectType: "teleport" as "externalCall",
        })
      ).rejects.toThrow(/effect_ledger_type_check/);
    });
  });

  runTenantIsolationContract({
    name: "effect_ledger",
    makeStore: () => new PostgresEffectLedger(),
    createTenant: createTestTenant,
    ...effectLedgerIsolation(),
  });
});
