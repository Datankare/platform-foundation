/**
 * platform/rag/chunker.ts — Document chunking
 *
 * Splits documents into overlapping chunks for embedding.
 * Two strategies: sliding-window (character-based) and sentence-aware.
 *
 * P2:  Composable pipeline step
 * P5:  Chunking config is versioned
 * P13: Config values tunable via platform-config
 *
 * @module platform/rag
 */

import type { Document, Chunk, ChunkingConfig } from "./types";
import { DEFAULT_CHUNKING_CONFIG } from "./types";
import { generateId } from "@/platform/agents/utils";

/**
 * Chunk a document into overlapping segments.
 *
 * @param doc - Source document
 * @param config - Chunking configuration (optional, uses defaults)
 * @returns Array of chunks preserving document metadata
 */
export function chunkDocument(
  doc: Document,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): readonly Chunk[] {
  if (!doc.content || doc.content.trim().length === 0) {
    return [];
  }

  if (config.maxChunkSize <= 0) {
    throw new Error("maxChunkSize must be positive");
  }

  if (config.overlapSize < 0) {
    throw new Error("overlapSize must be non-negative");
  }

  if (config.overlapSize >= config.maxChunkSize) {
    throw new Error("overlapSize must be less than maxChunkSize");
  }

  switch (config.strategy) {
    case "sentence":
      return chunkBySentence(doc, config);
    case "sliding-window":
    default:
      return chunkBySlidingWindow(doc, config);
  }
}

// ── Sliding window ────────────────────────────────────────────────────

function chunkBySlidingWindow(doc: Document, config: ChunkingConfig): readonly Chunk[] {
  const chunks: Chunk[] = [];
  const text = doc.content;
  const step = config.maxChunkSize - config.overlapSize;
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    const end = Math.min(offset + config.maxChunkSize, text.length);
    const content = text.slice(offset, end);

    chunks.push({
      id: generateId(),
      documentId: doc.id,
      content,
      index,
      startOffset: offset,
      endOffset: end,
      metadata: { ...doc.metadata, source: doc.source },
    });

    offset += step;
    index++;

    if (end === text.length) break;
  }

  return chunks;
}

// ── Sentence-aware ────────────────────────────────────────────────────

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

// TODO: If a single sentence exceeds maxChunkSize, it is included whole.
// This preserves semantic coherence for embeddings. If real document
// ingestion reveals frequent oversized sentences, add sliding-window
// fallback within sentence boundaries.
function chunkBySentence(doc: Document, config: ChunkingConfig): readonly Chunk[] {
  const sentences = doc.content.split(SENTENCE_BOUNDARY);
  const chunks: Chunk[] = [];
  let currentContent = "";
  let chunkStart = 0;
  let index = 0;

  for (const sentence of sentences) {
    if (
      currentContent.length > 0 &&
      currentContent.length + sentence.length > config.maxChunkSize
    ) {
      chunks.push({
        id: generateId(),
        documentId: doc.id,
        content: currentContent,
        index,
        startOffset: chunkStart,
        endOffset: chunkStart + currentContent.length,
        metadata: { ...doc.metadata, source: doc.source },
      });
      index++;

      const overlapText = currentContent.slice(-config.overlapSize);
      chunkStart = chunkStart + currentContent.length - overlapText.length;
      currentContent = overlapText;
    }

    currentContent += (currentContent.length > 0 ? " " : "") + sentence;
  }

  if (currentContent.trim().length > 0) {
    chunks.push({
      id: generateId(),
      documentId: doc.id,
      content: currentContent,
      index,
      startOffset: chunkStart,
      endOffset: chunkStart + currentContent.length,
      metadata: { ...doc.metadata, source: doc.source },
    });
  }

  return chunks;
}
