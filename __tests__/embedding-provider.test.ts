/**
 * EmbeddingProvider interface contract — mock arm (ADR-027).
 */
import { runEmbeddingProviderContract } from "./contract/embedding-provider-contract";
import { createMockEmbeddingProvider } from "@/platform/rag/mock-embedding-provider";

describe("EmbeddingProvider contract — mock provider", () => {
  runEmbeddingProviderContract({
    makeProvider: () => createMockEmbeddingProvider(),
  });
});
