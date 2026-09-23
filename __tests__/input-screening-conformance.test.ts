/**
 * input-screening-conformance.test.ts — ADR-043 L21: the reference RAG data path
 * (ingestDocument + retrieve) satisfies the input-screening contract at both points.
 */
import { runInputScreeningContract } from "./contract/input-screening-contract";
import {
  ingestDocument,
  retrieve,
  InMemoryEmbeddingStore,
  createMockEmbeddingProvider,
  registerKnowledgeBase,
  resetKnowledgeBases,
} from "@/platform/rag";
import type { InputScreen, ScreenDecision } from "@/platform/rag/screen";
import type { Document, RetrievalQuery, Scope } from "@/platform/rag/types";

// The kit injects a forced screen, so no real moderation runs. This mock only stops the
// default seam's module-level import from pulling the Guardian chain into the test.
jest.mock("@/platform/moderation/middleware", () => ({
  screenContent: jest.fn(async () => ({ action: "allow" })),
}));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req",
}));

const SCOPE: Scope = { knowledgeBaseId: "kb-screen", dimensions: {} };
const DOC: Document = {
  id: "d1",
  content: "the quick brown fox jumps over the lazy dog",
  source: "test",
  mimeType: "text/plain",
  metadata: {},
};

function forced(decision: ScreenDecision | "throw"): InputScreen {
  return async () => {
    if (decision === "throw") throw new Error("screen failure");
    return decision;
  };
}
function freshKB(): void {
  resetKnowledgeBases();
  registerKnowledgeBase({
    id: "kb-screen",
    name: "Screen KB",
    isolationLevel: "shared",
    boundary: [],
  });
}

runInputScreeningContract({
  name: "RAG data path (ingestDocument + retrieve)",
  ingestUnder: async (f) => {
    freshKB();
    const store = new InMemoryEmbeddingStore();
    const provider = createMockEmbeddingProvider();
    await ingestDocument(SCOPE, DOC, provider, store, { screen: forced(f) });
    return { entered: (await store.count(SCOPE)) > 0 };
  },
  queryUnder: async (f) => {
    freshKB();
    const store = new InMemoryEmbeddingStore();
    const provider = createMockEmbeddingProvider();
    // Seed one allowed document so an allowed query has something to retrieve.
    await ingestDocument(SCOPE, DOC, provider, store, {
      screen: forced({ action: "allow" }),
    });
    const query: RetrievalQuery = { query: DOC.content, topK: 10, minScore: 0 };
    const out = await retrieve(SCOPE, query, provider, store, { screen: forced(f) });
    return { retrieved: out.results.length > 0 };
  },
});
