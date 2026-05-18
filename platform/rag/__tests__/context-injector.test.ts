/**
 * platform/rag/__tests__/context-injector.test.ts
 *
 * Tests for context injection into AI prompts.
 */

import { buildContextBlock } from "../context-injector";
import type { RetrievalResult, ContextInjectionConfig } from "../types";

function makeResult(id: string, content: string, score = 0.9): RetrievalResult {
  return {
    chunk: {
      id,
      documentId: "doc-1",
      content,
      index: 0,
      startOffset: 0,
      endOffset: content.length,
      metadata: {},
    },
    score,
  };
}

describe("buildContextBlock", () => {
  it("returns empty for no results", () => {
    const result = buildContextBlock([]);
    expect(result.contextBlock).toBe("");
    expect(result.chunksIncluded).toBe(0);
    expect(result.contentChars).toBe(0);
    expect(result.includedChunkIds).toEqual([]);
  });

  it("includes single result with prefix and suffix", () => {
    const results = [makeResult("c1", "Hello world")];
    const result = buildContextBlock(results);
    expect(result.contextBlock).toContain("<retrieved_context>");
    expect(result.contextBlock).toContain("</retrieved_context>");
    expect(result.chunksIncluded).toBe(1);
    expect(result.includedChunkIds).toEqual(["c1"]);
  });

  it("includes multiple results separated by double newlines", () => {
    const results = [makeResult("c1", "First chunk"), makeResult("c2", "Second chunk")];
    const result = buildContextBlock(results);
    expect(result.chunksIncluded).toBe(2);
    expect(result.includedChunkIds).toEqual(["c1", "c2"]);
  });

  it("respects character budget", () => {
    const config: ContextInjectionConfig = {
      maxContextChars: 80,
      contextPrefix: "<ctx>",
      contextSuffix: "</ctx>",
    };
    const results = [
      makeResult("c1", "A".repeat(30)),
      makeResult("c2", "B".repeat(30)),
      makeResult("c3", "C".repeat(30)),
    ];
    const result = buildContextBlock(results, config);
    expect(result.chunksIncluded).toBeLessThan(3);
    expect(result.contextBlock.length).toBeLessThanOrEqual(80);
  });

  it("returns empty when budget consumed by prefix/suffix", () => {
    const config: ContextInjectionConfig = {
      maxContextChars: 10,
      contextPrefix: "<retrieved_context>",
      contextSuffix: "</retrieved_context>",
    };
    const results = [makeResult("c1", "Hello")];
    const result = buildContextBlock(results, config);
    expect(result.contextBlock).toBe("");
    expect(result.chunksIncluded).toBe(0);
  });

  it("tracks contentChars accurately", () => {
    const config: ContextInjectionConfig = {
      maxContextChars: 500,
      contextPrefix: "<c>",
      contextSuffix: "</c>",
    };
    const results = [makeResult("c1", "Hello"), makeResult("c2", "World")];
    const result = buildContextBlock(results, config);
    expect(result.contentChars).toBeGreaterThan(10);
  });

  it("uses default config when none provided", () => {
    const results = [makeResult("c1", "Test content")];
    const result = buildContextBlock(results);
    expect(result.contextBlock).toContain("<retrieved_context>");
  });
});
