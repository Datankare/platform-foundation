/**
 * StrikeStore conformance (ADR-027): the in-memory reference and the Supabase store, the latter
 * against an in-memory database that evaluates its real queries (helpers/fake-database.ts).
 */
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { InMemoryStrikeStore, SupabaseStrikeStore } from "@/platform/moderation/strikes";
import { runStrikeStoreContract } from "./contract/strike-store-contract";
import { FakeDatabase } from "./helpers/fake-database";

describe("StrikeStore contract — in-memory store", () => {
  runStrikeStoreContract({ makeStore: () => new InMemoryStrikeStore() });
});

describe("StrikeStore contract — Supabase store", () => {
  runStrikeStoreContract({
    makeStore: () => {
      const db = new FakeDatabase({ user_strikes: [] }, { timestamps: true });
      (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
      return new SupabaseStrikeStore();
    },
  });
});

describe("Supabase strike store — injected failure", () => {
  it("throws when the strike history cannot be read, rather than reporting none", async () => {
    (getSupabaseServiceClient as jest.Mock).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: async () => ({ data: null, error: { message: "down" } }),
            }),
          }),
        }),
      }),
    });
    const store = new SupabaseStrikeStore();
    await expect(
      store.getActiveStrikes("00000000-0000-4000-8000-0000000000a1")
    ).rejects.toThrow(/unreadable/);
  });
});
