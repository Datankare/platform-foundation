/**
 * kb-registry.test.ts — the knowledge-base registry (ADR-042 D1/D4).
 */
import {
  registerKnowledgeBase,
  getKnowledgeBase,
  hasKnowledgeBase,
  listKnowledgeBases,
  resetKnowledgeBases,
} from "../kb-registry";
import { setEmbeddingStore, InMemoryEmbeddingStore } from "../index";
import type { EmbeddingStore, IsolationLevel } from "../types";

beforeEach(() => {
  resetKnowledgeBases();
  setEmbeddingStore(new InMemoryEmbeddingStore());
});

describe("KB registry", () => {
  it("registers, gets, has, and lists a knowledge base", () => {
    registerKnowledgeBase({
      id: "kb1",
      name: "One",
      isolationLevel: "shared",
      boundary: ["tenant"],
    });
    expect(hasKnowledgeBase("kb1")).toBe(true);
    expect(getKnowledgeBase("kb1")?.boundary).toEqual(["tenant"]);
    expect(listKnowledgeBases()).toEqual(["kb1"]);
  });

  it("refuses a duplicate id (fail-closed)", () => {
    const cfg = {
      id: "kb1",
      name: "One",
      isolationLevel: "shared" as const,
      boundary: [],
    };
    registerKnowledgeBase(cfg);
    expect(() => registerKnowledgeBase(cfg)).toThrow(/already registered/);
  });

  it("refuses an isolation level the store cannot enforce (fail-closed, no downgrade)", () => {
    // A store that only supports `shared`.
    const sharedOnly: EmbeddingStore = {
      supportedLevels: (): readonly IsolationLevel[] => ["shared"],
      upsert: async () => {},
      search: async () => [],
      deleteByDocument: async () => 0,
      count: async () => 0,
    };
    setEmbeddingStore(sharedOnly);
    expect(() =>
      registerKnowledgeBase({
        id: "kbD",
        name: "Dedicated",
        isolationLevel: "dedicated",
        boundary: [],
      })
    ).toThrow(/does not support isolation level "dedicated"/);
  });

  it("reset clears the registry", () => {
    registerKnowledgeBase({
      id: "kb1",
      name: "One",
      isolationLevel: "shared",
      boundary: [],
    });
    resetKnowledgeBases();
    expect(listKnowledgeBases()).toEqual([]);
  });
});
