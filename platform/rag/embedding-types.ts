/**
 * platform/rag/embedding-types.ts — Embedding provider types
 *
 * Provider interface for text-to-vector embedding.
 * Slot #13 in the provider registry.
 *
 * GenAI Principles:
 *   P3  — Observable: every embed call instrumented
 *   P7  — Provider-aware: interface + mock + real implementations
 *   P12 — Economic transparency: cost tracked per embed call
 *
 * @module platform/rag
 */

// ── Embedding Model Registry ──────────────────────────────────────────

/**
 * Configuration for an embedding model.
 * Mirrors ModelConfig pattern from platform/ai/types.ts.
 */
export interface EmbeddingModelConfig {
  /** Model identifier (vendor-specific) */
  readonly modelId: string;
  /** Human-readable label */
  readonly label: string;
  /** Vector dimensions produced by this model */
  readonly dimensions: number;
  /** Cost per 1M input tokens (USD) */
  readonly costPer1MTokens: number;
}

/** Supported embedding models */
export const EMBEDDING_MODEL_REGISTRY: Record<string, EmbeddingModelConfig> = {
  "text-embedding-3-small": {
    modelId: "text-embedding-3-small",
    label: "OpenAI text-embedding-3-small",
    dimensions: 1536,
    costPer1MTokens: 0.02,
  },
  "text-embedding-3-large": {
    modelId: "text-embedding-3-large",
    label: "OpenAI text-embedding-3-large",
    dimensions: 3072,
    costPer1MTokens: 0.13,
  },
  mock: {
    modelId: "mock",
    label: "Mock embedding (deterministic)",
    dimensions: 128,
    costPer1MTokens: 0,
  },
};

// ── Provider Interface ────────────────────────────────────────────────

/**
 * Request to embed text.
 */
export interface EmbeddingRequest {
  /** Text(s) to embed */
  readonly texts: readonly string[];
  /** Model to use (defaults to provider default) */
  readonly model?: string;
}

/**
 * Response from an embedding call.
 */
export interface EmbeddingResponse {
  /** Embedding vectors (one per input text, same order) */
  readonly embeddings: readonly (readonly number[])[];
  /** Model that was used */
  readonly model: string;
  /** Token usage */
  readonly usage: {
    readonly totalTokens: number;
  };
  /** Estimated cost in USD */
  readonly costUsd: number;
}

/**
 * EmbeddingProvider — generates vector embeddings from text.
 *
 * P7: Every provider implements this interface.
 * Registry slot #13 in platform/providers/registry.ts.
 */
export interface EmbeddingProvider {
  /** Provider name for logging */
  readonly name: string;
  /** Default model ID */
  readonly defaultModel: string;
  /** Vector dimensions for the default model */
  readonly dimensions: number;
  /** Embed one or more texts */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}
