/**
 * platform/ai/mock-provider.ts — Deterministic mock AI provider
 *
 * Reference implementation of AIProvider for tests and development without an
 * API key. Echoes the last user message; zero network, zero cost. Implements
 * both complete() and the optional stream().
 *
 * Created under ADR-027 — the AIProvider slot previously had no reference impl
 * to run the conformance kit against.
 *
 * P6  — Resilient fallback for the AI slot.
 * P7  — Provider-aware: interface + mock + real (Anthropic) implementations.
 *
 * @module platform/ai
 */

import type {
  AIProvider,
  AIRequest,
  AIResponse,
  AIStreamChunk,
  AIStreamOptions,
} from "./types";
import { MODEL_REGISTRY } from "./types";

function resolveModel(request: AIRequest): string {
  return MODEL_REGISTRY[request.tier].modelId;
}

function lastUserText(request: AIRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  const block = last.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Create a deterministic mock AI provider.
 */
export function createMockAIProvider(): AIProvider {
  return {
    name: "mock",

    async complete(request: AIRequest): Promise<AIResponse> {
      const echo = lastUserText(request).slice(0, 200);
      const text = `[MOCK] ${echo}`;
      return {
        content: [{ type: "text", text }],
        model: resolveModel(request),
        usage: {
          inputTokens: estimateTokens(echo),
          outputTokens: estimateTokens(text),
        },
        stopReason: "end_turn",
      };
    },

    async *stream(
      request: AIRequest,
      _options?: AIStreamOptions
    ): AsyncIterable<AIStreamChunk> {
      const echo = lastUserText(request).slice(0, 200);
      const text = `[MOCK] ${echo}`;
      const words = text.split(" ");
      for (let i = 0; i < words.length; i++) {
        const isLast = i === words.length - 1;
        yield { text: isLast ? words[i] : `${words[i]} `, done: false };
      }
      yield {
        text: "",
        done: true,
        usage: {
          inputTokens: estimateTokens(echo),
          outputTokens: estimateTokens(text),
          cost: 0,
        },
      };
    },
  };
}
