/**
 * platform/rag/retriever.ts — Retrieval pipeline
 *
 * Query → embed → vector search → rank → return.
 * Composes EmbeddingProvider + EmbeddingStore into a retrieval step.
 *
 * P2:  Composable pipeline step
 * P3:  Observable — every retrieval instrumented
 * P4:  Safety — sanitizeForPrompt on retrieved content
 * P11: Resilient — returns empty on failure, never crashes
 *
 * @module platform/rag
 */

import type { EmbeddingProvider } from "./embedding-types";
import type {
  EmbeddingStore,
  RetrievalQuery,
  RetrievalResult,
  ExplanationStep,
  Scope,
} from "./types";
import { DEFAULT_RETRIEVAL_CONFIG } from "./types";
import { getKnowledgeBase } from "./kb-registry";
import { assertScope } from "./scope";
import {
  defaultInputScreen,
  runInputScreen,
  screenPermits,
  type InputScreen,
} from "./screen";
import { logger, generateRequestId } from "@/lib/logger";

/**
 * Result from a retrieval operation, including explainability data.
 */
export interface RetrievalOutput {
  /** Retrieved chunks ranked by relevance */
  readonly results: readonly RetrievalResult[];
  /** Explanation steps for audit trail (P18) */
  readonly explanationSteps: readonly ExplanationStep[];
  /** Total retrieval time in ms */
  readonly durationMs: number;
}

/**
 * Options for {@link retrieve}.
 */
export interface RetrieveOptions {
  /** Injected screener (ADR-043 D6). Defaults to the Guardian-backed input screen. */
  readonly screen?: InputScreen;
  /** Trace-correlation id. Defaults to a generated one. */
  readonly requestId?: string;
}

/**
 * Retrieve relevant chunks for a query.
 *
 * Steps:
 * 1. Embed the query text
 * 2. Search the embedding store
 * 3. Return ranked results with explanation
 *
 * P11: On any failure, returns empty results (never throws).
 */
export async function retrieve(
  scope: Scope,
  query: RetrievalQuery,
  provider: EmbeddingProvider,
  store: EmbeddingStore,
  options: RetrieveOptions = {}
): Promise<RetrievalOutput> {
  const start = Date.now();
  const steps: ExplanationStep[] = [];
  const topK = query.topK ?? DEFAULT_RETRIEVAL_CONFIG.topK;
  const minScore = query.minScore ?? DEFAULT_RETRIEVAL_CONFIG.minScore;
  const screen = options.screen ?? defaultInputScreen;
  const requestId = options.requestId ?? generateRequestId();

  try {
    // Fail-closed: retrieval requires a registered KB and a scope that satisfies its
    // declared boundary (ADR-042 D3). A miss returns empty via the catch below.
    const kb = getKnowledgeBase(scope.knowledgeBaseId);
    if (!kb) throw new Error(`unknown knowledge base: ${scope.knowledgeBaseId}`);
    assertScope(kb.boundary, scope);

    // ADR-043 D3 (query): screen the query BEFORE embedding/search. Prompt-injection in
    // the query is withheld fail-closed (block/escalate/screen-error -> empty results).
    const screenStart = Date.now();
    const decision = await runInputScreen(screen, query.query, requestId);
    steps.push({
      phase: "input-screening",
      description: `Query screened: ${decision.action}`,
      data: { action: decision.action },
      durationMs: Date.now() - screenStart,
    });
    if (!screenPermits(decision)) {
      return { results: [], explanationSteps: steps, durationMs: Date.now() - start };
    }

    const embedStart = Date.now();
    const embedResponse = await provider.embed({ texts: [query.query] });
    const queryEmbedding = embedResponse.embeddings[0];
    steps.push({
      phase: "query-embedding",
      description: `Embedded query using ${embedResponse.model}`,
      data: {
        model: embedResponse.model,
        tokens: embedResponse.usage.totalTokens,
        costUsd: embedResponse.costUsd,
      },
      durationMs: Date.now() - embedStart,
    });

    const searchStart = Date.now();
    const results = await store.search(
      scope,
      queryEmbedding,
      topK,
      minScore,
      query.filters
    );
    steps.push({
      phase: "vector-search",
      description: `Searched ${await store.count(scope)} vectors, found ${results.length} above ${minScore} threshold`,
      data: {
        topK,
        minScore,
        resultsFound: results.length,
        topScore: results.length > 0 ? results[0].score : null,
      },
      durationMs: Date.now() - searchStart,
    });

    return {
      results,
      explanationSteps: steps,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Retrieval failed", { error: message, query: query.query });
    steps.push({
      phase: "error",
      description: `Retrieval failed: ${message}`,
      data: { error: message },
      durationMs: Date.now() - start,
    });
    return {
      results: [],
      explanationSteps: steps,
      durationMs: Date.now() - start,
    };
  }
}
