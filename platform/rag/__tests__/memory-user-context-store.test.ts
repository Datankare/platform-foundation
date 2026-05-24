/**
 * platform/rag/__tests__/memory-user-context-store.test.ts
 *
 * Tests for InMemoryUserContextStore.
 */

import { InMemoryUserContextStore } from "../memory-user-context-store";
import type { InteractionRecord, UserAIContext } from "../types";

function makeInteraction(id: string, input = "hello"): InteractionRecord {
  return {
    id,
    input,
    output: "response",
    feature: "test",
    timestamp: new Date().toISOString(),
  };
}

describe("InMemoryUserContextStore", () => {
  let store: InMemoryUserContextStore;

  beforeEach(() => {
    store = new InMemoryUserContextStore();
  });

  describe("getContext / saveContext", () => {
    it("returns undefined for unknown user", async () => {
      expect(await store.getContext("unknown")).toBeUndefined();
    });

    it("saves and retrieves context", async () => {
      const ctx: UserAIContext = {
        userId: "u1",
        interactions: [],
        preferences: { lang: "en" },
        patterns: ["prefers concise answers"],
        updatedAt: new Date().toISOString(),
      };
      await store.saveContext(ctx);
      const result = await store.getContext("u1");
      expect(result).toBeDefined();
      expect(result!.userId).toBe("u1");
      expect(result!.preferences).toEqual({ lang: "en" });
    });

    it("overwrites on second save", async () => {
      const ctx1: UserAIContext = {
        userId: "u1",
        interactions: [],
        preferences: { a: 1 },
        patterns: [],
        updatedAt: new Date().toISOString(),
      };
      const ctx2: UserAIContext = { ...ctx1, preferences: { b: 2 } };
      await store.saveContext(ctx1);
      await store.saveContext(ctx2);
      const result = await store.getContext("u1");
      expect(result!.preferences).toEqual({ b: 2 });
    });
  });

  describe("addInteraction", () => {
    it("creates context if none exists", async () => {
      await store.addInteraction("u1", makeInteraction("i1"));
      const ctx = await store.getContext("u1");
      expect(ctx).toBeDefined();
      expect(ctx!.interactions).toHaveLength(1);
      expect(ctx!.interactions[0].id).toBe("i1");
    });

    it("appends to existing interactions", async () => {
      await store.addInteraction("u1", makeInteraction("i1"));
      await store.addInteraction("u1", makeInteraction("i2"));
      const ctx = await store.getContext("u1");
      expect(ctx!.interactions).toHaveLength(2);
    });

    it("trims interactions beyond max", async () => {
      for (let i = 0; i < 105; i++) {
        await store.addInteraction("u1", makeInteraction(`i${i}`));
      }
      const ctx = await store.getContext("u1");
      expect(ctx!.interactions.length).toBeLessThanOrEqual(100);
    });
  });

  describe("updatePreferences", () => {
    it("creates context if none exists", async () => {
      await store.updatePreferences("u1", { theme: "dark" });
      const ctx = await store.getContext("u1");
      expect(ctx).toBeDefined();
      expect(ctx!.preferences).toEqual({ theme: "dark" });
    });

    it("merges with existing preferences", async () => {
      await store.updatePreferences("u1", { a: 1 });
      await store.updatePreferences("u1", { b: 2 });
      const ctx = await store.getContext("u1");
      expect(ctx!.preferences).toEqual({ a: 1, b: 2 });
    });

    it("overwrites same-key preferences", async () => {
      await store.updatePreferences("u1", { a: 1 });
      await store.updatePreferences("u1", { a: 99 });
      const ctx = await store.getContext("u1");
      expect(ctx!.preferences).toEqual({ a: 99 });
    });
  });

  describe("deleteContext", () => {
    it("deletes existing context", async () => {
      await store.addInteraction("u1", makeInteraction("i1"));
      await store.deleteContext("u1");
      expect(await store.getContext("u1")).toBeUndefined();
    });

    it("no-ops for unknown user", async () => {
      await store.deleteContext("unknown");
    });
  });
});
