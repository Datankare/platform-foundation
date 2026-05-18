/**
 * platform/rag/__tests__/chunker.test.ts
 *
 * Tests for document chunking: sliding-window and sentence strategies.
 */

import { chunkDocument } from "../chunker";
import type { Document, ChunkingConfig } from "../types";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

function makeDoc(content: string, id = "doc-1"): Document {
  return {
    id,
    content,
    source: "test.txt",
    mimeType: "text/plain",
    metadata: { author: "test" },
  };
}

describe("chunkDocument", () => {
  describe("sliding-window strategy", () => {
    const config: ChunkingConfig = {
      maxChunkSize: 100,
      overlapSize: 20,
      strategy: "sliding-window",
    };

    it("returns empty array for empty content", () => {
      const result = chunkDocument(makeDoc(""), config);
      expect(result).toEqual([]);
    });

    it("returns empty array for whitespace-only content", () => {
      const result = chunkDocument(makeDoc("   "), config);
      expect(result).toEqual([]);
    });

    it("returns single chunk for short content", () => {
      const result = chunkDocument(makeDoc("Hello world"), config);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Hello world");
      expect(result[0].index).toBe(0);
      expect(result[0].startOffset).toBe(0);
      expect(result[0].endOffset).toBe(11);
    });

    it("splits long content with overlap", () => {
      const text = "A".repeat(250);
      const result = chunkDocument(makeDoc(text), config);
      expect(result.length).toBeGreaterThan(1);

      expect(result[0].content.length).toBe(100);
      expect(result[0].startOffset).toBe(0);
      expect(result[1].startOffset).toBe(80);

      const overlap = result[0].content.slice(-20);
      const nextStart = result[1].content.slice(0, 20);
      expect(overlap).toBe(nextStart);
    });

    it("preserves document metadata on each chunk", () => {
      const result = chunkDocument(makeDoc("Hello world"), config);
      expect(result[0].metadata).toEqual({
        author: "test",
        source: "test.txt",
      });
    });

    it("assigns correct documentId to chunks", () => {
      const result = chunkDocument(makeDoc("Hello world", "doc-99"), config);
      expect(result[0].documentId).toBe("doc-99");
    });

    it("assigns sequential index values", () => {
      const text = "B".repeat(250);
      const result = chunkDocument(makeDoc(text), config);
      result.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });

    it("covers the full document text", () => {
      const text = "C".repeat(300);
      const result = chunkDocument(makeDoc(text), config);
      const lastChunk = result[result.length - 1];
      expect(lastChunk.endOffset).toBe(text.length);
    });
  });

  describe("sentence strategy", () => {
    const config: ChunkingConfig = {
      maxChunkSize: 80,
      overlapSize: 20,
      strategy: "sentence",
    };

    it("keeps short text as single chunk", () => {
      const result = chunkDocument(makeDoc("One sentence."), config);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("One sentence.");
    });

    it("splits at sentence boundaries", () => {
      const text =
        "First sentence is here and it keeps going with more words added. Second sentence follows with additional context and detail. Third sentence ends with a final flourish of words.";
      const result = chunkDocument(makeDoc(text), config);
      expect(result.length).toBeGreaterThan(1);
      expect(result[0].content).toContain("First sentence");
    });

    it("produces overlap between sentence chunks", () => {
      const text =
        "Alpha bravo charlie delta. Echo foxtrot golf hotel. India juliet kilo lima.";
      const result = chunkDocument(makeDoc(text), config);
      if (result.length > 1) {
        const lastOfFirst = result[0].content.slice(-10);
        expect(result[1].content).toContain(lastOfFirst.trim());
      }
    });

    it("handles single very long sentence", () => {
      const text = "D".repeat(200) + ".";
      const result = chunkDocument(makeDoc(text), config);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(text);
    });
  });

  describe("config validation", () => {
    it("throws on zero maxChunkSize", () => {
      expect(() =>
        chunkDocument(makeDoc("test"), {
          maxChunkSize: 0,
          overlapSize: 0,
          strategy: "sliding-window",
        })
      ).toThrow("maxChunkSize must be positive");
    });

    it("throws on negative overlapSize", () => {
      expect(() =>
        chunkDocument(makeDoc("test"), {
          maxChunkSize: 100,
          overlapSize: -1,
          strategy: "sliding-window",
        })
      ).toThrow("overlapSize must be non-negative");
    });

    it("throws when overlapSize >= maxChunkSize", () => {
      expect(() =>
        chunkDocument(makeDoc("test"), {
          maxChunkSize: 100,
          overlapSize: 100,
          strategy: "sliding-window",
        })
      ).toThrow("overlapSize must be less than maxChunkSize");
    });
  });

  describe("default config", () => {
    it("uses defaults when no config provided", () => {
      const result = chunkDocument(makeDoc("Hello world"));
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Hello world");
    });
  });
});
