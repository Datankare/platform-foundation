/**
 * __tests__/effect-ledger-conformance.test.ts
 * The EffectLedger kit against the in-memory ledger, and the tenant isolation kit against its
 * tenant partitions (ADR-053 D6). The Postgres ledger: __tests__/db/effect-ledger.db.test.ts.
 */

import { runEffectLedgerContract } from "./contract/effect-ledger-contract";
import { runTenantIsolationContract } from "./contract/tenant-isolation-contract";
import { effectLedgerIsolation, memoryTenant } from "./helpers/store-isolation-fixtures";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";

describe("InMemoryEffectLedger — conformance", () => {
  runEffectLedgerContract({ makeLedger: () => new InMemoryEffectLedger() });
});

describe("InMemoryEffectLedger — tenants", () => {
  runTenantIsolationContract({
    name: "effect ledger (memory)",
    makeStore: () => new InMemoryEffectLedger(),
    createTenant: memoryTenant,
    ...effectLedgerIsolation(),
    failsClosedWithoutTenant: false,
  });

  it("lists only the current tenant's unresolved entries", async () => {
    const ledger = new InMemoryEffectLedger();
    const fx = effectLedgerIsolation();
    const a = await memoryTenant();
    const b = await memoryTenant();
    await a.run(() => fx.write(ledger, "op"));
    expect(await b.run(() => ledger.listUnresolved())).toEqual([]);
    expect(await a.run(() => ledger.listUnresolved())).toHaveLength(1);
    ledger.clear();
    expect(await a.run(() => ledger.listUnresolved())).toEqual([]);
  });
});
