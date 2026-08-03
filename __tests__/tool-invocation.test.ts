/**
 * __tests__/tool-invocation.test.ts
 * Runs the tool invocation conformance kit.
 */

import { runToolInvocationContract } from "./contract/tool-invocation-contract";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";

describe("invokeTool — conformance", () => {
  runToolInvocationContract({
    makeTrajectoryStore: () => new InMemoryTrajectoryStore(),
  });
});
