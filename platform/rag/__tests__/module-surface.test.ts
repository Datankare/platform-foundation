/**
 * TASK-204 (N-4): platform/rag's public surface, now inside coverage — what an app imports from
 * `@/platform/rag` is what each implementing file exports (the barrel re-exports the real thing,
 * not a copy or nothing), and the module's three stores are one per process: a default until set,
 * the previous one handed back on a set, the defaults again after a reset.
 */
import * as rag from "@/platform/rag";
import { chunkDocument } from "@/platform/rag/chunker";
import { InMemoryEmbeddingStore } from "@/platform/rag/memory-embedding-store";
import { PostgresEmbeddingStore } from "@/platform/rag/postgres-embedding-store";
import { retrieve } from "@/platform/rag/retriever";
import { ingestDocument } from "@/platform/rag/ingest";
import { CURATOR_REFERENCE_KB, registerRagReference } from "@/platform/rag/bootstrap";
import { defaultInputScreen, runInputScreen, screenPermits } from "@/platform/rag/screen";
import { assertScope, ScopeError, scopeKey } from "@/platform/rag/scope";
import { buildContextBlock } from "@/platform/rag/context-injector";
import { InMemoryUserContextStore } from "@/platform/rag/memory-user-context-store";
import { createExplanationBuilder } from "@/platform/rag/explainability";
import { createMockEmbeddingProvider } from "@/platform/rag/mock-embedding-provider";
import { EMBEDDING_MODEL_REGISTRY } from "@/platform/rag/embedding-types";
import {
  DEFAULT_CHUNKING_CONFIG,
  DEFAULT_INJECTION_CONFIG,
  DEFAULT_RETRIEVAL_CONFIG,
} from "@/platform/rag/types";
import * as kb from "@/platform/rag/kb-registry";

afterEach(() => rag.resetRAG());

describe("@/platform/rag: its public surface", () => {
  it("re-exports each implementing file's own value", () => {
    const pairs: [string, unknown, unknown][] = [
      ["chunkDocument", rag.chunkDocument, chunkDocument],
      ["InMemoryEmbeddingStore", rag.InMemoryEmbeddingStore, InMemoryEmbeddingStore],
      ["PostgresEmbeddingStore", rag.PostgresEmbeddingStore, PostgresEmbeddingStore],
      ["retrieve", rag.retrieve, retrieve],
      ["ingestDocument", rag.ingestDocument, ingestDocument],
      ["registerRagReference", rag.registerRagReference, registerRagReference],
      ["CURATOR_REFERENCE_KB", rag.CURATOR_REFERENCE_KB, CURATOR_REFERENCE_KB],
      ["defaultInputScreen", rag.defaultInputScreen, defaultInputScreen],
      ["screenPermits", rag.screenPermits, screenPermits],
      ["runInputScreen", rag.runInputScreen, runInputScreen],
      ["scopeKey", rag.scopeKey, scopeKey],
      ["assertScope", rag.assertScope, assertScope],
      ["ScopeError", rag.ScopeError, ScopeError],
      ["buildContextBlock", rag.buildContextBlock, buildContextBlock],
      [
        "InMemoryUserContextStore",
        rag.InMemoryUserContextStore,
        InMemoryUserContextStore,
      ],
      [
        "createExplanationBuilder",
        rag.createExplanationBuilder,
        createExplanationBuilder,
      ],
      [
        "createMockEmbeddingProvider",
        rag.createMockEmbeddingProvider,
        createMockEmbeddingProvider,
      ],
      [
        "EMBEDDING_MODEL_REGISTRY",
        rag.EMBEDDING_MODEL_REGISTRY,
        EMBEDDING_MODEL_REGISTRY,
      ],
      ["DEFAULT_CHUNKING_CONFIG", rag.DEFAULT_CHUNKING_CONFIG, DEFAULT_CHUNKING_CONFIG],
      [
        "DEFAULT_RETRIEVAL_CONFIG",
        rag.DEFAULT_RETRIEVAL_CONFIG,
        DEFAULT_RETRIEVAL_CONFIG,
      ],
      [
        "DEFAULT_INJECTION_CONFIG",
        rag.DEFAULT_INJECTION_CONFIG,
        DEFAULT_INJECTION_CONFIG,
      ],
    ];
    for (const [name, exported, own] of pairs) {
      expect([name, exported]).toEqual([name, expect.anything()]);
      expect([name, exported === own]).toEqual([name, true]);
    }
  });

  it("re-exports the knowledge-base registry's five functions", () => {
    const names = [
      "registerKnowledgeBase",
      "getKnowledgeBase",
      "hasKnowledgeBase",
      "listKnowledgeBases",
      "resetKnowledgeBases",
    ] as const;
    for (const name of names) {
      expect([name, typeof rag[name], rag[name] === kb[name]]).toEqual([
        name,
        "function",
        true,
      ]);
    }
  });
});

describe("@/platform/rag: one store of each kind per process", () => {
  it("the embedding store: a default, the previous one handed back on a set, a reset's new default", () => {
    const first = rag.getEmbeddingStore();
    expect(first).toBeInstanceOf(InMemoryEmbeddingStore);
    expect(rag.getEmbeddingStore()).toBe(first);
    const mine = new InMemoryEmbeddingStore();
    expect(rag.setEmbeddingStore(mine)).toBe(first);
    expect(rag.getEmbeddingStore()).toBe(mine);
    rag.resetRAG();
    expect(rag.getEmbeddingStore()).not.toBe(mine);
    expect(rag.getEmbeddingStore()).toBeInstanceOf(InMemoryEmbeddingStore);
  });

  it("the embedding provider", () => {
    const first = rag.getEmbeddingProvider();
    expect(rag.getEmbeddingProvider()).toBe(first);
    const mine = createMockEmbeddingProvider();
    expect(rag.setEmbeddingProvider(mine)).toBe(first);
    expect(rag.getEmbeddingProvider()).toBe(mine);
    rag.resetRAG();
    expect(rag.getEmbeddingProvider()).not.toBe(mine);
  });

  it("the user context store", () => {
    const first = rag.getUserContextStore();
    expect(first).toBeInstanceOf(InMemoryUserContextStore);
    const mine = new InMemoryUserContextStore();
    expect(rag.setUserContextStore(mine)).toBe(first);
    expect(rag.getUserContextStore()).toBe(mine);
    rag.resetRAG();
    expect(rag.getUserContextStore()).not.toBe(mine);
  });
});
