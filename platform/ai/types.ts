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
  /**
   * Cost per 1M prompt tokens read from the prompt cache (USD). Per model, not a fixed multiple
   * of the input price: Sonnet 5.5 bills reads at 0.05x, Haiku 4.5 at 0.1x.
   */
  cacheReadCostPer1M: number;
  /** Cost per 1M prompt tokens written to the prompt cache, 5-minute TTL (USD) */
  cacheWriteCostPer1M: number;
  /** Whether the model accepts `temperature`; Sonnet 5.5 answers a request carrying it with a 400 */
  acceptsTemperature: boolean;
  /** The `thinking` setting sent on every request to this model, when it needs one */
  thinking?: { type: "between_tools" };
}

/** Model registry — maps tiers to concrete models */
export const MODEL_REGISTRY: Record<ModelTier, ModelConfig> = {
  fast: {
    modelId: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    inputCostPer1M: 1.0,
    outputCostPer1M: 5.0,
    // platform.claude.com/docs/en/about-claude/pricing, 2026-10-28: hits $0.10, 5m writes $1.25
    cacheReadCostPer1M: 0.1,
    cacheWriteCostPer1M: 1.25,
    acceptsTemperature: true,
  },
  standard: {
    // Sonnet 4 (claude-sonnet-4-20250514) was retired 2026-06-15. Sonnet 5.5 thinks by default,
    // and thinking counts against max_tokens; our prompts budget 256-1024 tokens for the reply
    // alone, so "between_tools" turns off up-front thinking (Sonnet 5.5 cannot disable thinking:
    // it may still think between tool calls, and those thinking blocks are passed back — see
    // AIThinkingBlock). It rejects temperature, so the prompts' low temperatures apply on the
    // fast tier only.
    modelId: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    inputCostPer1M: 2.0,
    outputCostPer1M: 10.0,
    // platform.claude.com/docs/en/about-claude/pricing, 2026-10-28: hits $0.10 (0.05x input),
    // 5m writes $2.50
    cacheReadCostPer1M: 0.1,
    cacheWriteCostPer1M: 2.5,
    acceptsTemperature: false,
    thinking: { type: "between_tools" },
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
export type AIContentBlock =
  | AITextBlock
  | AIToolUseBlock
  | AIToolResultBlock
  | AIImageBlock
  | AIAudioBlock
  | AIThinkingBlock;

/**
 * The model's thinking (`thinking` or `redacted_thinking`), opaque. Kept in a response's content
 * so a tool loop can pass the assistant turn back: Sonnet 5.5 may think between tool calls, and
 * the API needs those blocks, unmodified and signed, in the next request. Never rendered, never
 * read: `raw` is the provider's block exactly as it arrived, and goes back exactly so.
 */
export interface AIThinkingBlock {
  type: "thinking";
  raw: Readonly<Record<string, unknown>>;
}

/** Input/output modalities a provider may support (ADR-044). */
export type Modality = "text" | "image" | "audio";

/** Image content block — base64 bytes + declared MIME (provider-portable, ADR-044 D1). */
export interface AIImageBlock {
  type: "image";
  source: { mediaType: string; data: string };
}

/** Audio content block — base64 bytes + declared MIME (ADR-044 D1). */
export interface AIAudioBlock {
  type: "audio";
  source: { mediaType: string; data: string };
}

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
  /**
   * A fixed opening of the system prompt that may be cached: sent before `system`, as its own
   * block. **Fixed, tenant-free text only** — the same bytes for every tenant and user (a
   * prompt template's static instructions), never a tenant's name, settings, data or a user's
   * input. `system` (sent after it) is where anything per-tenant goes, and is never cached.
   */
  cacheablePrefix?: string;
  /**
   * Ask for Anthropic's prompt cache on `cacheablePrefix` (and the tools, which render before
   * it). **Fixed, tenant-free prefixes only.** Both this flag and the governed setting
   * `ai.prompt_cache_enabled` (default off) must be true, and the request must carry a
   * `cacheablePrefix`: the orchestrator drops the flag while the setting is off, and the
   * provider puts a cache breakpoint only after `cacheablePrefix` — never on `system`, the tools
   * alone or the messages. Otherwise the request is sent exactly as before.
   *
   * Cost: a cache write bills the prefix at the model's cacheWriteCostPer1M (1.25x input), a
   * read at its cacheReadCostPer1M (0.05x on Sonnet 5.5, 0.1x on Haiku 4.5), so it pays only
   * where the same prefix is re-sent within the cache's 5 minutes; a route sent less often pays
   * 25% more on the prefix. A prefix under the model's minimum (512 tokens on Sonnet 5.5, 4096
   * on Haiku 4.5) is not cached: its tokens are billed as ordinary input, with no write premium.
   */
  promptCache?: boolean;
}

/**
 * Token usage of one call, as the API reports it. `inputTokens` is the uncached remainder of
 * the prompt: the prompt's total is inputTokens + cacheReadTokens + cacheWriteTokens.
 */
export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from Anthropic's prompt cache (ModelConfig.cacheReadCostPer1M) */
  cacheReadTokens?: number;
  /** Prompt tokens written to the prompt cache (ModelConfig.cacheWriteCostPer1M) */
  cacheWriteTokens?: number;
}

/** Response from the LLM provider */
export interface AIResponse {
  /** Response content blocks */
  content: AIContentBlock[];
  /** Model that was used */
  model: string;
  /** Token usage */
  usage: AIUsage;
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
  usage?: AIUsage & { cost?: number };
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
/**
 * What a provider accepts and produces, per modality (ADR-044 D2). The single source of
 * truth for modality-aware routing; ADR-045 reads `outputs`, the orchestrator reads `inputs`.
 */
export interface ProviderCapabilities {
  readonly inputs: readonly Modality[];
  readonly outputs: readonly Modality[];
}

export interface AIProvider {
  /** Provider name for logging */
  readonly name: string;
  /** Declared per-modality capability (ADR-044 D2). */
  readonly capabilities: ProviderCapabilities;
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
  /** Prompt tokens served from Anthropic's prompt cache */
  cacheReadTokens?: number;
  /** Prompt tokens written to Anthropic's prompt cache */
  cacheWriteTokens?: number;
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
