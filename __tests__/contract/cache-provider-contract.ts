/**
 * __tests__/contract/cache-provider-contract.ts
 * CacheProvider conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type { CacheProvider } from "@/platform/cache/types";

export interface CacheContractFixtures {
  makeProvider: () => CacheProvider | Promise<CacheProvider>;
}

export function runCacheProviderContract(fx: CacheContractFixtures): void {
  let cache: CacheProvider;

  beforeEach(async () => {
    cache = await fx.makeProvider();
    await cache.clear();
  });

  describe("name", () => {
    it("exposes a non-empty provider name", () => {
      expect(typeof cache.name).toBe("string");
      expect(cache.name.length).toBeGreaterThan(0);
    });
  });

  describe("get / set", () => {
    it("returns a stored value", async () => {
      await cache.set("contract:key", "value-1");
      const v = await cache.get<string>("contract:key");
      expect(v).toBe("value-1");
    });

    it("returns null for a missing key", async () => {
      const v = await cache.get("contract:absent");
      expect(v).toBeNull();
    });

    it("overwrites an existing value", async () => {
      await cache.set("contract:key", "value-1");
      await cache.set("contract:key", "value-2");
      const v = await cache.get<string>("contract:key");
      expect(v).toBe("value-2");
    });
  });

  describe("has / delete", () => {
    it("reports presence and deletes", async () => {
      await cache.set("contract:key", "value-1");
      expect(await cache.has("contract:key")).toBe(true);
      const deleted = await cache.delete("contract:key");
      expect(deleted).toBe(true);
      expect(await cache.has("contract:key")).toBe(false);
    });

    it("returns false when deleting a missing key", async () => {
      const deleted = await cache.delete("contract:absent");
      expect(deleted).toBe(false);
    });
  });

  describe("clear", () => {
    it("removes all keys", async () => {
      await cache.set("contract:a", 1);
      await cache.set("contract:b", 2);
      await cache.clear();
      expect(await cache.has("contract:a")).toBe(false);
      expect(await cache.has("contract:b")).toBe(false);
    });
  });

  describe("health", () => {
    it("reports a well-formed health status", async () => {
      const h = await cache.health();
      expect(typeof h.connected).toBe("boolean");
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof h.provider).toBe("string");
      expect(h.provider.length).toBeGreaterThan(0);
    });
  });
}
