/**
 * platform/rag/types.ts — Core RAG pipeline types
 *
 * Types for document chunking, retrieval, context injection,
 * user AI context, and explainability.
 *
 * GenAI Principles:
 *   P1  — Intent-driven: retrieval queries are structured
 *   P2  — Agentic execution: pipeline as composable steps
 *   P6  — Structured outputs: all types enforce schemas
 *   P8  — Context & memory: RAG = retrieval layer; user context = semantic layer
 *   P16 — Cognitive memory: user context maps to episodic + semantic memory
 *   P18 — Durable trajectories: retrieval steps are logged events
 *
 * @module platform/rag
 */

// ── Document ──────────────────────────────────────────────────────────

/**
 * A source document to be chunked and embedded.
 */
export interface Document {
  /** Unique document ID */
  readonly id: string;
  /** Raw text content */
  readonly content: string;
  /** Source identifier (file path, URL, etc.) */
  readonly source: string;
  /** MIME type of the original document */
  readonly mimeType: string;
  /** Extensible metadata (author, date, tags, etc.) */
  readonly metadata: Record<string, unknown>;
}

// ── Chunk ─────────────────────────────────────────────────────────────

/**
 * A chunk of a document, ready for embedding.
 *
 * Chunks preserve their position in the source document and carry
 * forward the document's metadata for filtering during retrieval.
 */
export interface Chunk {
  /** Unique chunk ID */
  readonly id: string;
  /** ID of the source document */
  readonly documentId: string;
  /** Chunk text content */
  readonly content: string;
  /** Position of this chunk in the document (0-indexed) */
  readonly index: number;
  /** Character offset where this chunk starts in the source */
  readonly startOffset: number;
  /** Character offset where this chunk ends in the source */
  readonly endOffset: number;
  /** Inherited + chunk-specific metadata */
  readonly metadata: Record<string, unknown>;
}

// ── Chunking Config ───────────────────────────────────────────────────

/**
 * Configuration for document chunking.
 *
 * P13: Configurable via platform-config.
 */
export interface ChunkingConfig {
  /** Maximum characters per chunk */
  readonly maxChunkSize: number;
  /** Overlap between adjacent chunks (characters) */
  readonly overlapSize: number;
  /** Chunking strategy */
  readonly strategy: ChunkingStrategy;
}

/** Available chunking strategies */
export type ChunkingStrategy = "sliding-window" | "sentence";

/** Sensible defaults — tuned for typical document sizes */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxChunkSize: 1000,
  overlapSize: 200,
  strategy: "sliding-window",
};

// ── Retrieval ─────────────────────────────────────────────────────────

/**
 * A structured retrieval query.
 *
 * P1: Parsed from natural language into structured form.
 */
export interface RetrievalQuery {
  /** The text query to embed and search */
  readonly query: string;
  /** Maximum number of results to return */
  readonly topK: number;
  /** Minimum similarity score (0–1) to include */
  readonly minScore: number;
  /** Optional metadata filters */
  readonly filters?: Record<string, unknown>;
  /** ID of the user making the query (for context scoping) */
  readonly userId?: string;
}

/** Sensible retrieval defaults */
export const DEFAULT_RETRIEVAL_CONFIG = {
  topK: 5,
  minScore: 0.7,
} as const;

/**
 * A single retrieval result — a chunk with its similarity score.
 */
export interface RetrievalResult {
  /** The matched chunk */
  readonly chunk: Chunk;
  /** Similarity score (0–1, higher = more similar) */
  readonly score: number;
}

// ── Context Injection ─────────────────────────────────────────────────

/**
 * Configuration for context injection into AI prompts.
 */
export interface ContextInjectionConfig {
  /** Maximum total characters of context to inject */
  readonly maxContextChars: number;
  /** Prefix before injected context */
  readonly contextPrefix: string;
  /** Suffix after injected context */
  readonly contextSuffix: string;
}

/** Default injection config */
export const DEFAULT_INJECTION_CONFIG: ContextInjectionConfig = {
  maxContextChars: 4000,
  contextPrefix: "<retrieved_context>",
  contextSuffix: "</retrieved_context>",
};

// ── User AI Context ───────────────────────────────────────────────────

/**
 * Per-user AI context — interaction history, preferences, patterns.
 *
 * P16: Maps to cognitive memory architecture:
 *   - interactions → episodic memory
 *   - preferences → semantic memory
 *   - patterns → procedural memory
 */
export interface UserAIContext {
  /** User ID */
  readonly userId: string;
  /** Recent interaction summaries (episodic) */
  readonly interactions: readonly InteractionRecord[];
  /** User preferences extracted from interactions (semantic) */
  readonly preferences: Record<string, unknown>;
  /** Learned patterns about user behavior (procedural) */
  readonly patterns: readonly string[];
  /** Last updated timestamp */
  readonly updatedAt: string;
}

/**
 * A single user interaction record (episodic memory).
 */
export interface InteractionRecord {
  /** Unique interaction ID */
  readonly id: string;
  /** What the user asked/did */
  readonly input: string;
  /** What the system responded/did */
  readonly output: string;
  /** Which feature/agent handled it */
  readonly feature: string;
  /** ISO timestamp */
  readonly timestamp: string;
  /** Optional quality signal (1–5) */
  readonly rating?: number;
}

// ── Explainability ────────────────────────────────────────────────────

/**
 * An explanation chain — why an AI decision was made.
 *
 * P10: Human oversight — users/admins can inspect AI reasoning.
 * P18: Trajectories — each step is an inspectable event.
 */
export interface ExplanationChain {
  /** Unique explanation ID */
  readonly id: string;
  /** The request that triggered this chain */
  readonly requestId: string;
  /** Ordered steps in the explanation */
  readonly steps: readonly ExplanationStep[];
  /** Final decision/output summary */
  readonly conclusion: string;
  /** ISO timestamp */
  readonly createdAt: string;
}

/**
 * A single step in an explanation chain.
 */
export interface ExplanationStep {
  /** Step label (e.g., "context-retrieval", "prompt-construction", "model-response") */
  readonly phase: string;
  /** Human-readable description of what happened */
  readonly description: string;
  /** Data involved (retrieved chunks, prompt snippet, etc.) */
  readonly data: Record<string, unknown>;
  /** Duration of this step in milliseconds */
  readonly durationMs: number;
}

// ── Store interfaces ──────────────────────────────────────────────────

/**
 * EmbeddingStore — persistence for document embeddings.
 *
 * P7: Provider-aware — InMemory for tests, Supabase+pgvector for prod.
 */
export interface EmbeddingStore {
  /** Store a chunk with its embedding vector. */
  upsert(chunkId: string, embedding: readonly number[], chunk: Chunk): Promise<void>;

  /** Search for similar embeddings. Returns chunks ranked by similarity. */
  search(
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    filters?: Record<string, unknown>
  ): Promise<readonly RetrievalResult[]>;

  /** Delete all embeddings for a document. */
  deleteByDocument(documentId: string): Promise<number>;

  /** Count stored embeddings (diagnostics). */
  count(): Promise<number>;
}

/**
 * UserContextStore — persistence for per-user AI context.
 *
 * P16: Cognitive memory store.
 */
export interface UserContextStore {
  /** Get user context. Returns undefined if no context exists. */
  getContext(userId: string): Promise<UserAIContext | undefined>;

  /** Save or update user context. */
  saveContext(context: UserAIContext): Promise<void>;

  /** Add an interaction record to user context. */
  addInteraction(userId: string, interaction: InteractionRecord): Promise<void>;

  /** Update user preferences. */
  updatePreferences(userId: string, preferences: Record<string, unknown>): Promise<void>;

  /** Delete user context (GDPR). */
  deleteContext(userId: string): Promise<void>;
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// (L17) Module-level gotchas — add issues here as they're discovered.
//
// 1. All fields are `readonly` — use spread operator for modifications.
// 2. Chunk.content is the text to embed, not the full document.
// 3. RetrievalResult.score is 0–1 (cosine similarity), NOT distance.
// 4. ExplanationChain.steps are ordered — maintain insertion order.
