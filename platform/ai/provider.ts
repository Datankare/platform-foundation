/**
 * platform/ai/provider.ts — LLM provider implementations
 *
 * ADR-015: Provider abstraction — Anthropic primary, pluggable fallback.
 * Every provider implements the AIProvider interface.
 * No raw fetch() to LLM APIs after Phase 2.
 */

import {
  AIProvider,
  AIRequest,
  AIResponse,
  AIContentBlock,
  AIUsage,
  AIStreamChunk,
  AIStreamOptions,
  MODEL_REGISTRY,
} from "./types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { estimateCost } from "./instrumentation";
import { logger } from "@/lib/logger";
import {
  classifyHttpFailure,
  externalFailure,
  TRANSIENT_REASONS_FOR_AI,
  type ExternalFailureReason,
} from "./provider-failure";

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly capabilities = {
    inputs: ["text", "image"] as const,
    outputs: ["text"] as const,
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
    this.baseUrl = baseUrl || "https://api.anthropic.com";
  }

  async complete(request: AIRequest): Promise<AIResponse> {
    const modelConfig = MODEL_REGISTRY[request.tier];

    if (!this.apiKey) {
      throw new AIProviderError("ANTHROPIC_API_KEY not configured", "config");
    }

    const body: Record<string, unknown> = {
      model: modelConfig.modelId,
      max_tokens: request.maxTokens,
      messages: toWireMessages(request.messages),
    };

    Object.assign(body, cachedPrefix(request, request.system));

    if (request.temperature !== undefined && modelConfig.acceptsTemperature) {
      body.temperature = request.temperature;
    }

    if (modelConfig.thinking) {
      body.thinking = modelConfig.thinking;
    }

    const response = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
      maxRetries: 2,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("Anthropic API error", {
        status: response.status,
        route: "platform/ai/provider",
      });
      const reason = anthropicFailureReason(response.status, errorBody);
      externalFailure("anthropic", reason, `Anthropic API returned ${response.status}`, {
        status: response.status,
      });
      throw new AIProviderError(
        `Anthropic API returned ${response.status}: ${errorBody}`,
        aiErrorKind(reason),
        { reason, status: response.status }
      );
    }

    const data = await response.json();

    const usage: AIUsage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    };

    // A safety decline is an HTTP 200 with no usable content; surface it, not an empty reply.
    // It is still billed: the error carries the usage, so its cost is recorded.
    if (data.stop_reason === "refusal") {
      throw new AIRefusalError(usage, modelConfig.modelId);
    }

    const content: AIContentBlock[] = (data.content || []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (block: any): AIContentBlock => {
        // The model's thinking is not its reply, but a tool loop must pass it back unmodified
        // (Sonnet 5.5 thinks between tool calls): kept opaque, never rendered.
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          return { type: "thinking", raw: block };
        }
        if (block.type === "text") {
          return { type: "text", text: block.text };
        }
        if (block.type === "tool_use") {
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        // Fallback: treat unknown blocks as text
        return { type: "text", text: JSON.stringify(block) };
      }
    );

    return {
      content,
      model: data.model || modelConfig.modelId,
      usage,
      stopReason: data.stop_reason || "end_turn",
    };
  }

  /**
   * Stream a completion response using Anthropic's streaming API.
   * Yields AIStreamChunk objects as they arrive.
   *
   * @see https://docs.anthropic.com/en/api/messages-streaming
   */
  async *stream(
    request: AIRequest,
    options?: AIStreamOptions
  ): AsyncIterable<AIStreamChunk> {
    const modelConfig = MODEL_REGISTRY[request.tier];

    if (!this.apiKey) {
      throw new AIProviderError("ANTHROPIC_API_KEY not configured", "config");
    }

    const body: Record<string, unknown> = {
      model: modelConfig.modelId,
      max_tokens: options?.maxTokens ?? request.maxTokens,
      stream: true,
      messages: toWireMessages(request.messages),
    };

    Object.assign(body, cachedPrefix(request, options?.system ?? request.system));

    const temperature = options?.temperature ?? request.temperature;
    if (temperature !== undefined && modelConfig.acceptsTemperature) {
      body.temperature = temperature;
    }

    if (modelConfig.thinking) {
      body.thinking = modelConfig.thinking;
    }

    const response = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: options?.abortSignal,
      // A stream: the timeout covers the first byte; the caller's signal bounds the rest (G-9).
      stream: true,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const reason = anthropicFailureReason(response.status, errorBody);
      externalFailure(
        "anthropic",
        reason,
        `Anthropic streaming API returned ${response.status}`,
        { status: response.status }
      );
      throw new AIProviderError(
        `Anthropic streaming API returned ${response.status}: ${errorBody}`,
        aiErrorKind(reason),
        { reason, status: response.status }
      );
    }

    if (!response.body) {
      throw new AIProviderError("Anthropic streaming response has no body", "transient");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let refused = false;
    // TASK-197 (audit D-1): a stream is complete only at message_stop. An `error` event mid-stream
    // (Anthropic's overloaded_error, api_error…) or a body that ends without message_stop is a
    // failure — thrown, so the caller answers a coded error, the failure is counted and the
    // circuit breaker sees it — never a short answer reported as done.
    let streamError: { type: string; message: string } | null = null;
    let stopped = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);

            if (event.type === "message_start") {
              inputTokens = event.message?.usage?.input_tokens ?? 0;
              cacheReadTokens = event.message?.usage?.cache_read_input_tokens ?? 0;
              cacheWriteTokens = event.message?.usage?.cache_creation_input_tokens ?? 0;
            } else if (event.type === "content_block_delta") {
              // Only the reply streams to the caller; thinking deltas are skipped.
              const text =
                event.delta?.type === "text_delta" ? (event.delta.text ?? "") : "";
              if (text) {
                yield { text, done: false };
              }
            } else if (event.type === "message_delta") {
              refused = event.delta?.stop_reason === "refusal";
              outputTokens = event.usage?.output_tokens ?? 0;
            } else if (event.type === "error") {
              streamError = {
                type:
                  typeof event.error?.type === "string"
                    ? event.error.type
                    : "unknown_error",
                message:
                  typeof event.error?.message === "string" ? event.error.message : "",
              };
            } else if (event.type === "message_stop") {
              stopped = true;
              yield {
                text: "",
                done: true,
                usage: {
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  cost: estimateCost(request.tier, {
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                  }),
                },
              };
            }
          } catch {
            // Skip unparseable lines
          }

          // Thrown outside the parse guard above, which would swallow it.
          if (refused) {
            throw new AIRefusalError(
              { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
              modelConfig.modelId
            );
          }
          if (streamError) throw streamFailure(streamError);
          if (stopped) {
            // Complete: what follows message_stop (nothing, by the protocol) is not read.
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
      }
      // The body ended without message_stop: the answer is cut off, not complete.
      throw streamFailure({ type: "incomplete_stream", message: "" });
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt caching
// ---------------------------------------------------------------------------

/**
 * `system` and `tools` for a request. Without `cacheablePrefix`, `system` is sent as a string,
 * exactly as before, and nothing is marked for the cache — whatever `promptCache` says, so a
 * system prompt that carries a tenant's context can never be cached. With one, the system prompt
 * is two blocks, the fixed prefix then `system`; when `promptCache` is on (the orchestrator
 * leaves it on only while `ai.prompt_cache_enabled` is), the one cache breakpoint goes at the end
 * of the prefix: the cached span is the tools (which render first) and the prefix, never `system`
 * or the messages, which change every call.
 */
function cachedPrefix(
  request: AIRequest,
  system: string | undefined
): { system?: unknown; tools?: unknown[] } {
  const prefix: { system?: unknown; tools?: unknown[] } = {};
  if (request.tools && request.tools.length > 0) {
    prefix.tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  const fixed = request.cacheablePrefix;
  if (fixed) {
    prefix.system = [
      {
        type: "text",
        text: fixed,
        ...(request.promptCache === true ? { cache_control: { type: "ephemeral" } } : {}),
      },
      ...(system ? [{ type: "text", text: system }] : []),
    ];
  } else if (system) {
    prefix.system = system;
  }
  return prefix;
}

/**
 * A thinking block's `raw`, checked before it is sent: only the model's own kinds
 * (`thinking`, `redacted_thinking`), only in an assistant turn. Anything else — an image or a
 * tool_result smuggled in `raw`, or a thinking block in a user turn — is refused, never sent.
 */
function thinkingToWire(raw: unknown, role: string): unknown {
  const type =
    raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
  if (role !== "assistant" || (type !== "thinking" && type !== "redacted_thinking")) {
    throw new AIProviderError(
      "A thinking block may carry only the model's thinking, in an assistant turn",
      "permanent"
    );
  }
  return raw;
}

/**
 * Messages as the API takes them: an image's source in the API's shape, and a thinking block
 * passed back exactly as it arrived (its `raw`), unmodified.
 */
function toWireMessages(messages: AIRequest["messages"]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => {
            if (b.type === "thinking") return thinkingToWire(b.raw, m.role);
            if (b.type === "image") {
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: b.source.mediaType,
                  data: b.source.data,
                },
              };
            }
            return b;
          }),
  }));
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type AIErrorKind = "config" | "transient" | "permanent";

export class AIProviderError extends Error {
  readonly kind: AIErrorKind;
  /**
   * Why the provider failed, when it answered (TASK-197, audit D-8): `rate_limited` and
   * `overloaded` (429, 529 — transient), `credential` (401, 403), `model_retired` (404),
   * `quota` (an exhausted credit balance), `unavailable` (5xx), `rejected` (another 4xx).
   */
  readonly reason?: ExternalFailureReason;
  /** The HTTP status, when there was one. */
  readonly status?: number;

  constructor(
    message: string,
    kind: AIErrorKind,
    details: { readonly reason?: ExternalFailureReason; readonly status?: number } = {}
  ) {
    super(message);
    this.name = "AIProviderError";
    this.kind = kind;
    if (details.reason !== undefined) this.reason = details.reason;
    if (details.status !== undefined) this.status = details.status;
  }
}

/**
 * The classification table for an Anthropic answer (TASK-197, audit D-8): 429 and 529 are
 * transient (a 429 that outlived the transport's Retry-After waits is still throttling, not the
 * client's fault — so the circuit breaker counts it); 401 and 403 are a credential the platform
 * holds; 404 is a retired model (TASK-186, the request names a model that no longer exists); a
 * 400 for an exhausted credit balance is the plan, not the request.
 */
export function anthropicFailureReason(status: number, body = ""): ExternalFailureReason {
  if (status === 400 && /credit balance/i.test(body)) return "quota";
  return classifyHttpFailure(status, { notFound: "model_retired", body });
}

/** The kind an AIProviderError carries for a reason: transient when a retry may succeed. */
export function aiErrorKind(reason: ExternalFailureReason): AIErrorKind {
  return TRANSIENT_REASONS_FOR_AI.has(reason) ? "transient" : "permanent";
}

/** A stream that failed mid-way (an `error` event) or ended without message_stop. */
function streamFailure(event: { type: string; message: string }): AIProviderError {
  // Anthropic's mid-stream error types: overloaded_error and api_error are theirs and pass;
  // rate_limit_error is throttling; anything else (invalid_request_error…) is the request's.
  const reason: ExternalFailureReason =
    event.type === "overloaded_error"
      ? "overloaded"
      : event.type === "rate_limit_error"
        ? "rate_limited"
        : event.type === "api_error" || event.type === "incomplete_stream"
          ? "unavailable"
          : event.type === "authentication_error" || event.type === "permission_error"
            ? "credential"
            : "rejected";
  externalFailure("anthropic", reason, `Anthropic stream failed: ${event.type}`);
  return new AIProviderError(
    `Anthropic stream failed (${event.type})${event.message ? `: ${event.message}` : ""}`,
    aiErrorKind(reason),
    { reason }
  );
}

/**
 * The model declined the request (`stop_reason: "refusal"`): permanent — the same request is
 * declined again — and not an outage. A route answers it with `ai.request_declined`, never
 * `service.unavailable`.
 */
export class AIRefusalError extends AIProviderError {
  /** What the declined call was billed for (a refusal is not free). */
  readonly usage: AIUsage;
  /** The model that declined, when known. */
  readonly model?: string;

  constructor(usage: AIUsage = { inputTokens: 0, outputTokens: 0 }, model?: string) {
    super("Anthropic declined the request (stop_reason: refusal)", "permanent");
    this.name = "AIRefusalError";
    this.usage = usage;
    this.model = model;
  }
}

/**
 * Whether `err` is a model refusal — also an AIRefusalError from another bundled copy of this
 * module (Next.js can load one per route bundle, ADR-032), where `instanceof` is false. The
 * precedent is isJsonLimitError (platform/errors/json-limits.ts).
 */
export function isAIRefusalError(err: unknown): err is AIRefusalError {
  return (
    err instanceof AIRefusalError ||
    (err instanceof Error &&
      err.name === "AIRefusalError" &&
      (err as { kind?: unknown }).kind === "permanent")
  );
}

/** The most tokens a refusal's usage is taken to count, per field. */
export const MAX_REFUSAL_TOKENS = 10_000_000;

/** The usage a refusal was billed for, or undefined for any other error. */
export function refusalUsage(err: unknown): AIUsage | undefined {
  if (!isAIRefusalError(err)) return undefined;
  const u = (err as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return undefined;
  // Numbers only, never negative, and capped: a hostile or broken count cannot make the recorded
  // cost Infinity or swamp a budget (no single call is billed near 10M tokens).
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0
      ? Math.min(Math.floor(v), MAX_REFUSAL_TOKENS)
      : 0;
  const x = u as Record<string, unknown>;
  return {
    inputTokens: n(x.inputTokens),
    outputTokens: n(x.outputTokens),
    cacheReadTokens: n(x.cacheReadTokens),
    cacheWriteTokens: n(x.cacheWriteTokens),
  };
}
