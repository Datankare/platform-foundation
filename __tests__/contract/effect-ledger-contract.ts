/**
 * __tests__/contract/effect-ledger-contract.ts
 * EffectLedger conformance kit — ADR-031 D7. Not a *.test.ts.
 *
 * The load-bearing arms are the two that make "does not re-fire" real: begin() must be
 * idempotent on (operationId, effectKey), and resolve() must transition only from pending.
 * An implementation that creates a second entry on retry grants a second permission to fire
 * the effect, and nothing in the type system prevents it.
 */

import type { EffectLedger } from "@/platform/kernel";

export interface EffectLedgerContractFixtures {
  makeLedger: () => EffectLedger | Promise<EffectLedger>;
}

export function runEffectLedgerContract(fx: EffectLedgerContractFixtures): void {
  let ledger: EffectLedger;

  const args = {
    operationId: "op_1",
    effectKey: "charge",
    effectType: "externalCall" as const,
  };

  beforeEach(async () => {
    ledger = await fx.makeLedger();
  });

  describe("begin", () => {
    it("writes a pending entry with an idempotency key derived from the operation", async () => {
      const e = await ledger.begin({ ...args, request: { amount: 10 } });
      expect(e.status).toBe("pending");
      expect(e.idempotencyKey).toContain("op_1");
      expect(e.attempts).toBe(1);
      expect(e.request).toEqual({ amount: 10 });
    });

    it("returns the EXISTING entry on retry, never a second one", async () => {
      const first = await ledger.begin(args);
      const second = await ledger.begin(args);
      expect(second.entryId).toBe(first.entryId);
      expect(second.attempts).toBe(2);
    });

    it("separates distinct effects within one operation", async () => {
      await ledger.begin(args);
      const other = await ledger.begin({ ...args, effectKey: "notify" });
      expect(other.attempts).toBe(1);
      expect((await ledger.get("op_1", "charge"))?.effectKey).toBe("charge");
      expect((await ledger.get("op_1", "notify"))?.effectKey).toBe("notify");
    });
  });

  describe("resolve", () => {
    it("confirms with a receipt", async () => {
      await ledger.begin(args);
      const r = await ledger.resolve("op_1", "charge", "confirmed", {
        receipt: { id: "ch_1" },
      });
      expect(r?.status).toBe("confirmed");
      expect(r?.receipt).toEqual({ id: "ch_1" });
      expect(r?.resolvedAt).toBeTruthy();
    });

    it("records indeterminate as a real state, not a failure", async () => {
      await ledger.begin(args);
      const r = await ledger.resolve("op_1", "charge", "indeterminate", {
        error: "timeout after send",
      });
      expect(r?.status).toBe("indeterminate");
      expect(r?.error).toMatch(/timeout/);
    });

    it("is a no-op on a second resolution", async () => {
      await ledger.begin(args);
      await ledger.resolve("op_1", "charge", "confirmed");
      const second = await ledger.resolve("op_1", "charge", "failed");
      expect(second).toBeUndefined();
      expect((await ledger.get("op_1", "charge"))?.status).toBe("confirmed");
    });

    it("returns undefined for an entry that was never begun", async () => {
      expect(await ledger.resolve("op_missing", "charge", "confirmed")).toBeUndefined();
    });
  });

  describe("listUnresolved", () => {
    it("returns pending and indeterminate, not confirmed or failed", async () => {
      await ledger.begin(args);
      await ledger.begin({ ...args, operationId: "op_2" });
      await ledger.begin({ ...args, operationId: "op_3" });
      await ledger.resolve("op_2", "charge", "confirmed");
      await ledger.resolve("op_3", "charge", "indeterminate");

      const unresolved = await ledger.listUnresolved();
      const ids = unresolved.map((e) => e.operationId).sort();

      expect(ids).toEqual(["op_1", "op_3"]);
    });

    it("honours limit", async () => {
      await ledger.begin(args);
      await ledger.begin({ ...args, operationId: "op_2" });
      expect(await ledger.listUnresolved(1)).toHaveLength(1);
    });

    it("returns everything when no limit is given", async () => {
      await ledger.begin(args);
      await ledger.begin({ ...args, operationId: "op_2" });
      await ledger.begin({ ...args, operationId: "op_3" });
      expect(await ledger.listUnresolved()).toHaveLength(3);
    });

    it("orders oldest first — the resolution queue is FIFO", async () => {
      await ledger.begin({ ...args, operationId: "op_1" });
      await ledger.begin({ ...args, operationId: "op_2" });
      const out = await ledger.listUnresolved();
      expect(out[0].operationId).toBe("op_1");
    });
  });
}
