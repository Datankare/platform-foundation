/**
 * platform/voice/chunker.ts — Text chunker for TTS
 *
 * TASK-020: Google Cloud TTS has a 5,000-byte limit per request.
 * This module splits text on sentence boundaries so each chunk
 * is under the limit, then audio from all chunks is concatenated.
 *
 * Rules:
 * 1. Split on sentence boundaries (. ! ? followed by space or end)
 * 2. If a single sentence exceeds the limit, split on clause boundaries (, ; :)
 * 3. If a single clause exceeds the limit, hard-split at byte boundary
 * 4. Preserve sentence order — no reordering
 * 5. Trim whitespace from each chunk
 *
 * @module platform/voice
 */

/** Default Google Cloud TTS byte limit */
export const TTS_BYTE_LIMIT = 5000;

/**
 * Get byte length of a string (UTF-8).
 * Multi-byte characters (CJK, Hindi, Arabic) count as 2-4 bytes.
 */
export function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Split text into chunks that each fit within the byte limit.
 * Prefers sentence boundaries, falls back to clause boundaries,
 * then hard-splits as last resort.
 *
 * @param text - Input text to chunk
 * @param maxBytes - Maximum bytes per chunk (default: 5000)
 * @returns Array of text chunks, each under maxBytes
 */
export function chunkText(text: string, maxBytes: number = TTS_BYTE_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // Fast path: text fits in one chunk
  if (getByteLength(trimmed) <= maxBytes) {
    return [trimmed];
  }

  // Split into sentences
  const sentences = splitSentences(trimmed);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;

    if (getByteLength(candidate) <= maxBytes) {
      current = candidate;
    } else if (current) {
      // Current buffer is full, flush it
      chunks.push(current.trim());
      // Check if this sentence alone fits
      if (getByteLength(sentence) <= maxBytes) {
        current = sentence;
      } else {
        // Sentence too long — split it further
        const subChunks = splitLongSegment(sentence, maxBytes);
        chunks.push(...subChunks.slice(0, -1));
        current = subChunks[subChunks.length - 1];
      }
    } else {
      // Empty buffer and sentence is too long
      const subChunks = splitLongSegment(sentence, maxBytes);
      chunks.push(...subChunks.slice(0, -1));
      current = subChunks[subChunks.length - 1];
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Split text into sentences.
 * Handles: period, exclamation, question mark followed by space or end.
 * Preserves the delimiter with the sentence.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or end
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Split a long segment on clause boundaries (, ; :).
 * Falls back to hard byte-split if clauses are still too long.
 */
function splitLongSegment(text: string, maxBytes: number): string[] {
  // Try clause boundaries first
  const clauses = text.split(/(?<=[,;:])\s+/);

  if (clauses.length > 1) {
    const chunks: string[] = [];
    let current = "";

    for (const clause of clauses) {
      const candidate = current ? `${current} ${clause}` : clause;
      if (getByteLength(candidate) <= maxBytes) {
        current = candidate;
      } else if (current) {
        chunks.push(current.trim());
        if (getByteLength(clause) <= maxBytes) {
          current = clause;
        } else {
          chunks.push(...hardSplit(clause, maxBytes));
          current = "";
        }
      } else {
        chunks.push(...hardSplit(clause, maxBytes));
        current = "";
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }
    return chunks;
  }

  // No clause boundaries — hard split
  return hardSplit(text, maxBytes);
}

/**
 * Hard-split text at byte boundary.
 * Splits at character boundaries (never mid-character).
 */
function hardSplit(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (getByteLength(remaining) > maxBytes) {
    // Binary search for the split point
    let lo = 0;
    let hi = remaining.length;

    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (getByteLength(remaining.slice(0, mid)) <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    if (lo === 0) {
      // Single character exceeds limit — shouldn't happen with 5000 byte limit
      lo = 1;
    }

    chunks.push(remaining.slice(0, lo).trim());
    remaining = remaining.slice(lo).trim();
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}
