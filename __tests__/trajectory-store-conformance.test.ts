/**
 * __tests__/trajectory-store-conformance.test.ts
 * Runs the TrajectoryStore conformance kit against the in-memory implementation.
 */

import { runTrajectoryStoreContract } from "./contract/trajectory-store-contract";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";

describe("InMemoryTrajectoryStore — conformance", () => {
  runTrajectoryStoreContract({
    makeStore: () => new InMemoryTrajectoryStore(),
  });
});
