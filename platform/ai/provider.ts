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
  MODEL_REGISTRY,
} from "./types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
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
        content: m.content,
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

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
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

    const content: AIContentBlock[] = (data.content || []).map(
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
