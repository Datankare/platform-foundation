/**
 * AIProvider interface contract — mock arm (ADR-027).
 * Runs the kit against the new MockAIProvider reference impl.
 */
import { runAIProviderContract } from "./contract/ai-provider-contract";
import { createMockAIProvider } from "@/platform/ai/mock-provider";

describe("AIProvider contract — mock provider", () => {
  runAIProviderContract({
    makeProvider: () => createMockAIProvider(),
  });
});
