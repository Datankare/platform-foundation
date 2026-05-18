/**
 * platform/rag/context-injector.ts — Context injection into AI prompts
 *
 * Takes retrieval results and injects them into prompt messages
 * within a token/character budget.
 *
 * P4:  Safety — sanitizeForPrompt applied to all retrieved content
 * P8:  Context management — scoped, budget-aware injection
 * P12: Economic transparency — context size tracked
 *
 * @module platform/rag
 */

import type { RetrievalResult, ContextInjectionConfig } from "./types";
import { DEFAULT_INJECTION_CONFIG } from "./types";
import { sanitizeForPrompt } from "@/lib/sanitize";

/**
 * Result of context injection.
 */
export interface InjectionResult {
  /** The assembled context string (with prefix/suffix) */
  readonly contextBlock: string;
  /** Number of chunks that fit in the budget */
  readonly chunksIncluded: number;
  /** Total characters of chunk content included */
  readonly contentChars: number;
  /** Chunk IDs that were included */
  readonly includedChunkIds: readonly string[];
}

/**
 * Build a context block from retrieval results.
 *
 * Chunks are added in relevance order until the character budget
 * is exhausted. All content is sanitized before injection.
 *
 * @param results - Retrieval results (already ranked by score)
 * @param config - Injection configuration
 * @returns Assembled context block with metadata
 */
export function buildContextBlock(
  results: readonly RetrievalResult[],
  config: ContextInjectionConfig = DEFAULT_INJECTION_CONFIG
): InjectionResult {
  if (results.length === 0) {
    return {
      contextBlock: "",
      chunksIncluded: 0,
      contentChars: 0,
      includedChunkIds: [],
    };
  }

  const budgetForContent =
    config.maxContextChars - config.contextPrefix.length - config.contextSuffix.length;

  if (budgetForContent <= 0) {
    return {
      contextBlock: "",
      chunksIncluded: 0,
      contentChars: 0,
      includedChunkIds: [],
    };
  }

  const parts: string[] = [];
  const includedIds: string[] = [];
  let usedChars = 0;

  for (const result of results) {
    const sanitized = sanitizeForPrompt(result.chunk.content);
    const separator = parts.length > 0 ? "\n\n" : "";
    const needed = separator.length + sanitized.length;

    if (usedChars + needed > budgetForContent) break;

    parts.push(sanitized);
    includedIds.push(result.chunk.id);
    usedChars += needed;
  }

  const innerContent = parts.join("\n\n");
  const contextBlock =
    parts.length > 0
      ? `${config.contextPrefix}\n${innerContent}\n${config.contextSuffix}`
      : "";

  return {
    contextBlock,
    chunksIncluded: parts.length,
    contentChars: usedChars,
    includedChunkIds: includedIds,
  };
}
