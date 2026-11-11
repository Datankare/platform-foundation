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

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/g;

/** A [start, end) span of the document's text. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** The document's sentences as spans (the whitespace between them is in neither). */
function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (const m of text.matchAll(SENTENCE_BOUNDARY)) {
    const end = m.index ?? 0;
    if (end > start) spans.push({ start, end });
    start = end + m[0].length;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans.filter((s) => text.slice(s.start, s.end).trim().length > 0);
}

/**
 * TASK-204 (N-51): a sentence longer than `max` is split within itself — at the last whitespace
 * in each window when there is one in its second half, else at `max` — so no piece passes the
 * bound (an embedding model's input limit). Leading whitespace of a piece is skipped.
 */
function boundedPieces(text: string, span: Span, max: number): Span[] {
  const pieces: Span[] = [];
  let start = span.start;
  while (start < span.end) {
    while (start < span.end && /\s/.test(text[start])) start++;
    if (start >= span.end) break;
    if (span.end - start <= max) {
      pieces.push({ start, end: span.end });
      break;
    }
    let cut = start + max;
    for (let i = cut; i > start + Math.floor(max / 2); i--) {
      if (/\s/.test(text[i])) {
        cut = i;
        break;
      }
    }
    pieces.push({ start, end: cut });
    start = cut;
  }
  return pieces;
}

/**
 * Sentences packed into chunks of at most `maxChunkSize` characters. Each chunk is a slice of the
 * document (`content` is `doc.content.slice(startOffset, endOffset)`); a chunk after the first
 * starts up to `overlapSize` characters before the previous one ended, less when the overlap and
 * the next sentence would together pass the bound.
 */
function chunkBySentence(doc: Document, config: ChunkingConfig): readonly Chunk[] {
  const text = doc.content;
  const max = config.maxChunkSize;
  const pieces = sentenceSpans(text).flatMap((s) => boundedPieces(text, s, max));
  const chunks: Chunk[] = [];
  const push = (start: number, end: number) => {
    chunks.push({
      id: generateId(),
      documentId: doc.id,
      content: text.slice(start, end),
      index: chunks.length,
      startOffset: start,
      endOffset: end,
      metadata: { ...doc.metadata, source: doc.source },
    });
  };

  let current: Span | null = null;
  for (const piece of pieces) {
    if (current === null) {
      current = piece;
      continue;
    }
    if (piece.end - current.start <= max) {
      current = { start: current.start, end: piece.end };
      continue;
    }
    push(current.start, current.end);
    const start = Math.min(
      piece.start,
      Math.max(current.end - config.overlapSize, piece.end - max, current.start)
    );
    current = { start, end: piece.end };
  }
  if (current !== null) push(current.start, current.end);
  return chunks;
}
