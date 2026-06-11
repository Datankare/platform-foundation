/**
 * SocialStore interface contract — reference arm (ADR-027).
 */
import { runSocialStoreContract } from "./contract/social-store-contract";
import { InMemorySocialStore } from "@/platform/social/memory-social-store";

describe("SocialStore contract — in-memory store", () => {
  runSocialStoreContract({
    makeStore: () => new InMemorySocialStore(),
  });
});
