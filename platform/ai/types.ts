/**
 * platform/ai/types.ts — Core types for the LLM orchestration layer
 *
 * ADR-015: GenAI-Native Stack Architecture
 * All AI interactions go through typed interfaces — no raw fetch().
 */

// ---------------------------------------------------------------------------
// Model tiering — Haiku for cheap/fast tasks, Sonnet for complex reasoning
// ---------------------------------------------------------------------------

export type ModelTier = "fast" | "standard";

export interface ModelConfig {
  /** Anthropic model identifier */
  modelId: string;
  /** Human-readable label */
  label: string;
  /** Cost per 1M input tokens (USD) — for instrumentation */
  inputCostPer1M: number;
  /** Cost per 1M output tokens (USD) — for instrumentation */
  outputCostPer1M: number;
}

/** Model registry — maps tiers to concrete models */
export const MODEL_REGISTRY: Record<ModelTier, ModelConfig> = {
  fast: {
    modelId: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    inputCostPer1M: 0.8,
    outputCostPer1M: 4.0,
  },
  standard: {
    modelId: "claude-sonnet-4-20250514",
    label: "Sonnet 4",
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
};

// ---------------------------------------------------------------------------
// Provider interface — what every LLM provider must implement
// ---------------------------------------------------------------------------

/** A single message in a conversation */
export interface AIMessage {
  role: "user" | "assistant";
  content: string | AIContentBlock[];
}

/** Content block — text or tool use */
export type AIContentBlock = AITextBlock | AIToolUseBlock | AIToolResultBlock;

export interface AITextBlock {
  type: "text";
  text: string;
}

export interface AIToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AIToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

/** Tool definition for function calling */
export interface AITool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Request to the LLM provider */
export interface AIRequest {
  /** Model tier — resolved to concrete model by orchestrator */
  tier: ModelTier;
  /** System prompt */
  system?: string;
  /** Conversation messages */
  messages: AIMessage[];
  /** Maximum tokens to generate */
  maxTokens: number;
  /** Optional tools for function calling */
  tools?: AITool[];
  /** Temperature (0–1) */
  temperature?: number;
}

/** Response from the LLM provider */
export interface AIResponse {
  /** Response content blocks */
  content: AIContentBlock[];
  /** Model that was used */
  model: string;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Stop reason */
  stopReason: string;
}

// ---------------------------------------------------------------------------
// AI Streaming — Sprint 5
// ---------------------------------------------------------------------------

/** A single chunk from an AI streaming response */
export interface AIStreamChunk {
  /** Text fragment */
  text: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Token usage (only present on final chunk) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost?: number;
  };
}

/** Options for AI streaming */
export interface AIStreamOptions {
  /** System prompt */
  system?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature (0–1) */
  temperature?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** Provider interface — implemented by each LLM vendor */
export interface AIProvider {
  /** Provider name for logging */
  readonly name: string;
  /** Send a completion request */
  complete(request: AIRequest): Promise<AIResponse>;
  /**
   * Stream a completion response. Optional — providers that don't support
   * streaming will have this undefined; the orchestrator falls back to complete().
   */
  stream?(request: AIRequest, options?: AIStreamOptions): AsyncIterable<AIStreamChunk>;
}

// ---------------------------------------------------------------------------
// Orchestrator options
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  /** Use case label for instrumentation (e.g., "safety-classify", "admin-command") */
  useCase: string;
  /** Request ID for tracing — propagated from the HTTP request */
  requestId: string;
  /** Optional: override the model tier for this call */
  tierOverride?: ModelTier;
}

// ---------------------------------------------------------------------------
// Instrumentation — per-call metrics
// ---------------------------------------------------------------------------

export interface AICallMetrics {
  /** Use case label */
  useCase: string;
  /** Request ID for correlation (legacy — use traceId for distributed tracing) */
  requestId: string;
  /** Trace ID for distributed tracing (ADR-014) */
  traceId?: string;
  /** Model used */
  model: string;
  /** Model tier */
  tier: ModelTier;
  /** Input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Whether response was served from cache */
  cached: boolean;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Timestamp */
  timestamp: string;
  /** Time to first token in ms (streaming only) */
  timeToFirstTokenMs?: number;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms before attempting recovery (half-open) */
  recoveryTimeMs: number;
  /** Number of successes in half-open needed to close */
  halfOpenSuccessThreshold: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeMs: 30_000,
  halfOpenSuccessThreshold: 2,
};
