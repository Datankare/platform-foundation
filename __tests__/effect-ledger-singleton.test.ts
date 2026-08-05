/**
 * __tests__/effect-ledger-singleton.test.ts
 *
 * Registry slot #18's wiring. setEffectLedger is what the provider registry calls, and
 * nothing else proved it takes effect — the same gap slot #17 had, and the same shape as
 * SupabaseActivityStateStore, which shipped dead because no test reached it (TASK-066).
 */

import {
  InMemoryEffectLedger,
  getEffectLedger,
  setEffectLedger,
  resetEffectLedger,
  idempotencyKeyFor,
} from "@/platform/agents/effect-ledger";

describe("effect ledger singleton (registry slot #18)", () => {
  afterEach(() => {
    resetEffectLedger();
  });

  it("defaults to an in-memory ledger", () => {
    expect(getEffectLedger()).toBeInstanceOf(InMemoryEffectLedger);
  });

  it("setEffectLedger takes effect and returns the previous ledger", async () => {
    const first = getEffectLedger();
    const replacement = new InMemoryEffectLedger();

    const previous = setEffectLedger(replacement);

    expect(previous).toBe(first);
    expect(getEffectLedger()).toBe(replacement);

    // Prove it is the ACTIVE ledger, not merely the returned one.
    await getEffectLedger().begin({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
    });
    expect(await replacement.listUnresolved()).toHaveLength(1);
  });

  it("resetEffectLedger installs a fresh ledger", async () => {
    await getEffectLedger().begin({
      operationId: "op_1",
      effectKey: "charge",
      effectType: "externalCall",
    });
    expect(await getEffectLedger().listUnresolved()).toHaveLength(1);

    resetEffectLedger();

    expect(await getEffectLedger().listUnresolved()).toHaveLength(0);
  });

  it("derives the idempotency key from the operation and effect (D7)", () => {
    const key = idempotencyKeyFor("op_1", "charge");
    expect(key).toContain("op_1");
    expect(key).toContain("charge");
    // Distinct effects within one operation must not share a key, or the downstream
    // would dedup two different effects into one.
    expect(idempotencyKeyFor("op_1", "notify")).not.toBe(key);
  });
});
