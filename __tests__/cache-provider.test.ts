/**
 * CacheProvider interface contract — mock arm (ADR-027).
 */
import { runCacheProviderContract } from "./contract/cache-provider-contract";
import { InMemoryCacheProvider } from "@/platform/cache/memory-cache";

describe("CacheProvider contract — in-memory provider", () => {
  runCacheProviderContract({
    makeProvider: () => new InMemoryCacheProvider(),
  });
});
