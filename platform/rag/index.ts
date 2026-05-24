/**
 * RAG Module — barrel exports and singleton.
 *
 * Usage:
 *   import { getEmbeddingStore, getEmbeddingProvider } from "@/platform/rag";
 *   const store = getEmbeddingStore();
 *   const provider = getEmbeddingProvider();
 *
 * @module platform/rag
 */

export type {
  Document,
  Chunk,
  ChunkingConfig,
  ChunkingStrategy,
  RetrievalQuery,
  RetrievalResult,
  ContextInjectionConfig,
  UserAIContext,
  InteractionRecord,
  ExplanationChain,
  ExplanationStep,
  EmbeddingStore,
  UserContextStore,
} from "./types";

export {
  DEFAULT_CHUNKING_CONFIG,
  DEFAULT_RETRIEVAL_CONFIG,
  DEFAULT_INJECTION_CONFIG,
} from "./types";

export type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingModelConfig,
} from "./embedding-types";

export { EMBEDDING_MODEL_REGISTRY } from "./embedding-types";

export { createMockEmbeddingProvider } from "./mock-embedding-provider";
export { chunkDocument } from "./chunker";
export { InMemoryEmbeddingStore } from "./memory-embedding-store";
export { retrieve } from "./retriever";
export type { RetrievalOutput } from "./retriever";
export { buildContextBlock } from "./context-injector";
export type { InjectionResult } from "./context-injector";
export { InMemoryUserContextStore } from "./memory-user-context-store";
export { createExplanationBuilder } from "./explainability";
export type { ExplanationBuilder } from "./explainability";

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

import type { EmbeddingStore } from "./types";
import type { EmbeddingProvider } from "./embedding-types";
import { InMemoryEmbeddingStore } from "./memory-embedding-store";
import { createMockEmbeddingProvider } from "./mock-embedding-provider";
import type { UserContextStore } from "./types";
import { InMemoryUserContextStore } from "./memory-user-context-store";

let currentEmbeddingStore: EmbeddingStore = new InMemoryEmbeddingStore();
let currentEmbeddingProvider: EmbeddingProvider = createMockEmbeddingProvider();
let currentUserContextStore: UserContextStore = new InMemoryUserContextStore();

/** Get the current embedding store. */
export function getEmbeddingStore(): EmbeddingStore {
  return currentEmbeddingStore;
}

/** Set the embedding store (for provider init or testing). */
export function setEmbeddingStore(store: EmbeddingStore): EmbeddingStore {
  const previous = currentEmbeddingStore;
  currentEmbeddingStore = store;
  return previous;
}

/** Get the current embedding provider. */
export function getEmbeddingProvider(): EmbeddingProvider {
  return currentEmbeddingProvider;
}

/** Set the embedding provider (for provider init or testing). */
export function setEmbeddingProvider(provider: EmbeddingProvider): EmbeddingProvider {
  const previous = currentEmbeddingProvider;
  currentEmbeddingProvider = provider;
  return previous;
}

/** Get the current user context store. */
export function getUserContextStore(): UserContextStore {
  return currentUserContextStore;
}

/** Set the user context store (for provider init or testing). */
export function setUserContextStore(store: UserContextStore): UserContextStore {
  const previous = currentUserContextStore;
  currentUserContextStore = store;
  return previous;
}

/** Reset all RAG singletons to defaults (testing only). */
export function resetRAG(): void {
  currentEmbeddingStore = new InMemoryEmbeddingStore();
  currentEmbeddingProvider = createMockEmbeddingProvider();
  currentUserContextStore = new InMemoryUserContextStore();
}
