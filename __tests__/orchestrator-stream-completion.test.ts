/**
 * TASK-197 (audit D-1): whatever the provider, a stream without its final chunk is a failure.
 *
 * Anthropic's stream parser ignored a mid-stream `error` event, and a stream that then closed
 * without message_stop was passed on as complete: /api/stream sent `done`, no failure metric was
 * written and the circuit breaker never saw it. The Anthropic wire cases are in the AI provider
 * contract (anthropic-provider-contract.test.ts). This holds the invariant one layer up, for any
 * provider an app plugs in: the orchestrator refuses a stream that ends without a `done` chunk —
 * it throws a transient AIProviderError (so the breaker counts it) and records a failed call.
 * Property-tested over arbitrary chunk sequences.
 */

import fc from "fast-check";
import {
  AIProviderError,
  clearMetrics,
  createOrchestrator,
  getRecentMetrics,
} from "@/platform/ai";
import type { AIProvider } from "@/platform/ai";
import type { AIStreamChunk } from "@/platform/ai/types";
import { fuzzParams } from "@/__tests__/helpers/fuzz";

fc.configureGlobal(fuzzParams());

function providerStreaming(chunks: readonly AIStreamChunk[]): AIProvider {
  return {
    name: "app-provider",
    capabilities: { inputs: ["text"], outputs: ["text"] },
    complete: jest.fn(),
    async *stream() {
      for (const c of chunks) yield c;
    },
  };
}

async function drain(provider: AIProvider, threshold = 5) {
  const orchestrator = createOrchestrator({
    provider,
    circuitBreakerConfig: {
      failureThreshold: threshold,
      recoveryTimeMs: 60_000,
      halfOpenSuccessThreshold: 1,
    },
  });
  const seen: AIStreamChunk[] = [];
  let thrown: unknown;
  try {
    for await (const c of orchestrator.stream(
      { tier: "fast", messages: [{ role: "user", content: "hi" }], maxTokens: 16 },
      { useCase: "test", requestId: "r-1" }
    )) {
      seen.push(c);
    }
  } catch (err) {
    thrown = err;
  }
  return { seen, thrown, orchestrator };
}

describe("orchestrator.stream — completion (TASK-197, audit D-1)", () => {
  beforeEach(() => clearMetrics());

  it("property: a provider stream without a done chunk throws transient and never says done", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), { maxLength: 12 }), async (texts) => {
        clearMetrics();
        const { seen, thrown } = await drain(
          providerStreaming(texts.map((text) => ({ text, done: false })))
        );
        expect(seen.some((c) => c.done)).toBe(false);
        expect(thrown).toBeInstanceOf(AIProviderError);
        expect((thrown as AIProviderError).kind).toBe("transient");
        expect(getRecentMetrics().some((m) => m.success === false)).toBe(true);
      })
    );
  });

  it("counts a cut-off stream toward the circuit breaker", async () => {
    const provider = providerStreaming([{ text: "partial", done: false }]);
    const orchestrator = createOrchestrator({
      provider,
      circuitBreakerConfig: {
        failureThreshold: 2,
        recoveryTimeMs: 60_000,
        halfOpenSuccessThreshold: 1,
      },
    });
    for (let i = 0; i < 2; i++) {
      await expect(async () => {
        for await (const c of orchestrator.stream(
          { tier: "fast", messages: [{ role: "user", content: "hi" }], maxTokens: 16 },
          { useCase: "test", requestId: `r-${i}` }
        )) {
          void c;
        }
      }).rejects.toBeInstanceOf(AIProviderError);
    }
    expect(orchestrator.getCircuitState()).toBe("open");
  });

  it("a complete stream passes untouched and stops at its final chunk", async () => {
    const { seen, thrown } = await drain(
      providerStreaming([
        { text: "a", done: false },
        { text: "b", done: true, usage: { inputTokens: 1, outputTokens: 1, cost: 0 } },
        { text: "after the end", done: false },
      ])
    );
    expect(thrown).toBeUndefined();
    expect(seen.map((c) => c.text)).toEqual(["a", "b"]);
  });
});
