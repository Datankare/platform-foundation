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
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const EMBEDDINGSTORE_KEY = "platform.rag.embeddingStore";
function readCurrentEmbeddingStore(): EmbeddingStore {
  return getSingleton<EmbeddingStore>(
    EMBEDDINGSTORE_KEY,
    () => new InMemoryEmbeddingStore()
  );
}
function writeCurrentEmbeddingStore(next: EmbeddingStore): void {
  setSingleton<EmbeddingStore>(EMBEDDINGSTORE_KEY, next);
}
/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const EMBEDDINGPROVIDER_KEY = "platform.rag.embeddingProvider";
function readCurrentEmbeddingProvider(): EmbeddingProvider {
  return getSingleton<EmbeddingProvider>(EMBEDDINGPROVIDER_KEY, () =>
    createMockEmbeddingProvider()
  );
}
function writeCurrentEmbeddingProvider(next: EmbeddingProvider): void {
  setSingleton<EmbeddingProvider>(EMBEDDINGPROVIDER_KEY, next);
}
/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const USERCONTEXTSTORE_KEY = "platform.rag.userContextStore";
function readCurrentUserContextStore(): UserContextStore {
  return getSingleton<UserContextStore>(
    USERCONTEXTSTORE_KEY,
    () => new InMemoryUserContextStore()
  );
}
function writeCurrentUserContextStore(next: UserContextStore): void {
  setSingleton<UserContextStore>(USERCONTEXTSTORE_KEY, next);
}

/** Get the current embedding store. */
export function getEmbeddingStore(): EmbeddingStore {
  return readCurrentEmbeddingStore();
}

/** Set the embedding store (for provider init or testing). */
export function setEmbeddingStore(store: EmbeddingStore): EmbeddingStore {
  const previous = readCurrentEmbeddingStore();
  writeCurrentEmbeddingStore(store);
  return previous;
}

/** Get the current embedding provider. */
export function getEmbeddingProvider(): EmbeddingProvider {
  return readCurrentEmbeddingProvider();
}

/** Set the embedding provider (for provider init or testing). */
export function setEmbeddingProvider(provider: EmbeddingProvider): EmbeddingProvider {
  const previous = readCurrentEmbeddingProvider();
  writeCurrentEmbeddingProvider(provider);
  return previous;
}

/** Get the current user context store. */
export function getUserContextStore(): UserContextStore {
  return readCurrentUserContextStore();
}

/** Set the user context store (for provider init or testing). */
export function setUserContextStore(store: UserContextStore): UserContextStore {
  const previous = readCurrentUserContextStore();
  writeCurrentUserContextStore(store);
  return previous;
}

/** Reset all RAG singletons to defaults (testing only). */
export function resetRAG(): void {
  writeCurrentEmbeddingStore(new InMemoryEmbeddingStore());
  writeCurrentEmbeddingProvider(createMockEmbeddingProvider());
  writeCurrentUserContextStore(new InMemoryUserContextStore());
}
