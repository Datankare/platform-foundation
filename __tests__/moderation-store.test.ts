/**
 * ModerationStore interface contract — reference arm (ADR-027).
 */
import { runModerationStoreContract } from "./contract/moderation-store-contract";
import { InMemoryModerationStore } from "@/platform/moderation/store";

describe("ModerationStore contract — in-memory store", () => {
  runModerationStoreContract({
    makeStore: () => new InMemoryModerationStore(),
  });
});
