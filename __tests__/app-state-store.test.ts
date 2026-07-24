/**
 * __tests__/app-state-store.test.ts
 * Runs the ActivityStateStore conformance kit against the in-memory implementation.
 */

import { runAppStateStoreContract } from "./contract/app-state-store-contract";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";

describe("InMemoryActivityStateStore — conformance", () => {
  runAppStateStoreContract({
    makeStore: () => new InMemoryActivityStateStore(),
  });
});
