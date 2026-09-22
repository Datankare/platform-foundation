/**
 * embedding-store-conformance.test.ts — ADR-042 L21: run the no-leak kit against every
 * registered store. Playform (and any adopter) runs the same kit against its own store.
 */
import { runEmbeddingStoreContract } from "./contract/embedding-store-contract";
import { InMemoryEmbeddingStore } from "@/platform/rag";

runEmbeddingStoreContract({
  name: "InMemoryEmbeddingStore",
  makeStore: () => new InMemoryEmbeddingStore(),
});
