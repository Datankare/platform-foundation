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
  AIStreamChunk,
  AIStreamOptions,
  MODEL_REGISTRY,
} from "./types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";

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
      messages: request.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((b) =>
                b.type === "image"
                  ? {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: b.source.mediaType,
                        data: b.source.data,
                      },
                    }
                  : b
              ),
      })),
    };

    if (request.system) {
      body.system = request.system;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

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
      throw new AIProviderError(
        `Anthropic API returned ${response.status}: ${errorBody}`,
        response.status >= 500 ? "transient" : "permanent"
      );
    }

    const data = await response.json();

    // A safety decline is an HTTP 200 with no usable content; surface it, not an empty reply.
    if (data.stop_reason === "refusal") {
      throw new AIProviderError(
        "Anthropic declined the request (stop_reason: refusal)",
        "permanent"
      );
    }

    const content: AIContentBlock[] = (data.content || [])
      // Thinking blocks are the model's working, not its reply; calls here are single-turn,
      // so nothing needs them passed back.
      .filter(
        (block: { type: string }) =>
          block.type !== "thinking" && block.type !== "redacted_thinking"
      )
      .map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (block: any): AIContentBlock => {
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
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
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
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (options?.system ?? request.system) {
      body.system = options?.system ?? request.system;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

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
      throw new AIProviderError(
        `Anthropic streaming API returned ${response.status}: ${errorBody}`,
        response.status >= 500 ? "transient" : "permanent"
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
    let refused = false;

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
            } else if (event.type === "message_stop") {
              yield {
                text: "",
                done: true,
                usage: {
                  inputTokens,
                  outputTokens,
                  cost:
                    (inputTokens * modelConfig.inputCostPer1M +
                      outputTokens * modelConfig.outputCostPer1M) /
                    1_000_000,
                },
              };
            }
          } catch {
            // Skip unparseable lines
          }

          // Thrown outside the parse guard above, which would swallow it.
          if (refused) {
            throw new AIProviderError(
              "Anthropic declined the request (stop_reason: refusal)",
              "permanent"
            );
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type AIErrorKind = "config" | "transient" | "permanent";

export class AIProviderError extends Error {
  readonly kind: AIErrorKind;

  constructor(message: string, kind: AIErrorKind) {
    super(message);
    this.name = "AIProviderError";
    this.kind = kind;
  }
}
