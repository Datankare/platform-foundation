/**
 * ingest.test.ts — ingestDocument (ADR-042 D5 + ADR-043 D3 ingest point).
 */
import { ingestDocument } from "../ingest";
import { InMemoryEmbeddingStore } from "../memory-embedding-store";
import { createMockEmbeddingProvider } from "../mock-embedding-provider";
import { registerKnowledgeBase, resetKnowledgeBases } from "../kb-registry";
import type { Document, Scope } from "../types";
import type { EmbeddingProvider } from "../embedding-types";
import type { InputScreen } from "../screen";

jest.mock("@/platform/moderation/middleware", () => ({
  screenContent: jest.fn(async () => ({ action: "allow" })),
}));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const SCOPE: Scope = { knowledgeBaseId: "kb-ingest", dimensions: {} };
const DOC: Document = {
  id: "d1",
  content: "hello world, this is a document worth chunking and embedding",
  source: "s",
  mimeType: "text/plain",
  metadata: { author: "x" },
};
const allow: InputScreen = async () => ({ action: "allow" });
const block: InputScreen = async () => ({ action: "block" });
const boom: InputScreen = async () => {
  throw new Error("screen down");
};

describe("ingestDocument", () => {
  let store: InMemoryEmbeddingStore;
  let provider: EmbeddingProvider;
  beforeEach(() => {
    resetKnowledgeBases();
    registerKnowledgeBase({
      id: "kb-ingest",
      name: "Ingest KB",
      isolationLevel: "shared",
      boundary: [],
    });
    store = new InMemoryEmbeddingStore();
    provider = createMockEmbeddingProvider();
  });

  it("ingests: chunks, embeds, upserts, returns a content version", async () => {
    const r = await ingestDocument(SCOPE, DOC, provider, store, { screen: allow });
    expect(r.status).toBe("ingested");
    expect(r.chunkCount).toBeGreaterThan(0);
    expect(r.contentVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(await store.count(SCOPE)).toBe(r.chunkCount);
  });

  it("stamps the content version into chunk metadata", async () => {
    const r = await ingestDocument(SCOPE, DOC, provider, store, { screen: allow });
    const q = (await provider.embed({ texts: [DOC.content] })).embeddings[0];
    const results = await store.search(SCOPE, q, 10, 0);
    expect(results[0].chunk.metadata.contentVersion).toBe(r.contentVersion);
  });

  it("withholds a blocked document (fail-closed, nothing enters the index)", async () => {
    const r = await ingestDocument(SCOPE, DOC, provider, store, { screen: block });
    expect(r.status).toBe("rejected");
    expect(r.rejectedBy).toBe("block");
    expect(await store.count(SCOPE)).toBe(0);
  });

  it("withholds when the screen errors (fail-closed to escalate)", async () => {
    const r = await ingestDocument(SCOPE, DOC, provider, store, { screen: boom });
    expect(r.status).toBe("rejected");
    expect(r.rejectedBy).toBe("escalate");
    expect(await store.count(SCOPE)).toBe(0);
  });

  it("throws on an unregistered knowledge base (fail-closed)", async () => {
    const bad: Scope = { knowledgeBaseId: "nope", dimensions: {} };
    await expect(
      ingestDocument(bad, DOC, provider, store, { screen: allow })
    ).rejects.toThrow(/unknown knowledge base/);
  });

  it("replaces prior chunks on re-ingest (idempotent count)", async () => {
    await ingestDocument(SCOPE, DOC, provider, store, { screen: allow });
    const first = await store.count(SCOPE);
    await ingestDocument(SCOPE, DOC, provider, store, { screen: allow });
    expect(await store.count(SCOPE)).toBe(first);
  });
});
