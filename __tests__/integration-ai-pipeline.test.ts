/**
 * Sprint 6 — Integration: AI Pipeline
 *
 * Tests the full AI orchestration pipeline:
 * orchestrator → provider → streaming → instrumentation → metrics.
 * Verifies Sprint 1 (orchestration) + Sprint 5 (streaming) work together.
 */

import { createOrchestrator, type Orchestrator } from "@/platform/ai/orchestrator";
import { AIProviderError } from "@/platform/ai/provider";
import type {
  AIProvider,
  AIRequest,
  AIStreamChunk,
  AICallMetrics,
} from "@/platform/ai/types";

// Track recorded metrics
const recordedMetrics: AICallMetrics[] = [];

jest.mock("@/platform/ai/instrumentation", () => ({
  estimateCost: jest.fn().mockReturnValue(0.001),
  recordMetrics: jest.fn((m: AICallMetrics) => recordedMetrics.push(m)),
}));

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Helpers ──

function makeRequest(text: string): AIRequest {
  return {
    tier: "fast",
    messages: [{ role: "user", content: text }],
    maxTokens: 100,
  };
}

const defaultOpts = { useCase: "integration-test", requestId: "int-1" };

function createMockProvider(overrides?: Partial<AIProvider>): AIProvider {
  return {
    name: "mock-integration",
    complete: jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "Hello from mock" }],
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 20 },
      stopReason: "end_turn",
    }),
    ...overrides,
  };
}

// ── Tests ──

describe("AI Pipeline Integration", () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    recordedMetrics.length = 0;
  });

  describe("complete() pipeline", () => {
    it("flows through provider → instrumentation → response", async () => {
      const provider = createMockProvider();
      orchestrator = createOrchestrator({ provider });

      const response = await orchestrator.complete(makeRequest("hello"), defaultOpts);

      expect(provider.complete).toHaveBeenCalledTimes(1);
      expect(response.content[0]).toEqual({ type: "text", text: "Hello from mock" });
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(20);

      // Verify metrics recorded
      expect(recordedMetrics).toHaveLength(1);
      expect(recordedMetrics[0].success).toBe(true);
      expect(recordedMetrics[0].useCase).toBe("integration-test");
      expect(recordedMetrics[0].latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("records failure metrics on provider error", async () => {
      const provider = createMockProvider({
        complete: jest
          .fn()
          .mockRejectedValue(new AIProviderError("API down", "transient")),
      });
      orchestrator = createOrchestrator({ provider });

      await expect(
        orchestrator.complete(makeRequest("hello"), defaultOpts)
      ).rejects.toThrow("API down");

      expect(recordedMetrics).toHaveLength(1);
      expect(recordedMetrics[0].success).toBe(false);
      expect(recordedMetrics[0].error).toContain("API down");
    });

    it("circuit breaker trips after repeated failures", async () => {
      const provider = createMockProvider({
        complete: jest.fn().mockRejectedValue(new AIProviderError("fail", "transient")),
      });
      orchestrator = createOrchestrator({
        provider,
        circuitBreakerConfig: {
          failureThreshold: 2,
          recoveryTimeMs: 60000,
          halfOpenSuccessThreshold: 1,
        },
      });

      // Trip the breaker
      for (let i = 0; i < 2; i++) {
        try {
          await orchestrator.complete(makeRequest("hello"), defaultOpts);
        } catch {
          // expected
        }
      }

      expect(orchestrator.getCircuitState()).toBe("open");

      // Next call should fail immediately with circuit breaker message
      await expect(
        orchestrator.complete(makeRequest("hello"), defaultOpts)
      ).rejects.toThrow("Circuit breaker");
    });

    it("tier override propagates to provider", async () => {
      const provider = createMockProvider();
      orchestrator = createOrchestrator({ provider });

      await orchestrator.complete(makeRequest("hello"), {
        ...defaultOpts,
        tierOverride: "standard",
      });

      const call = (provider.complete as jest.Mock).mock.calls[0][0];
      expect(call.tier).toBe("standard");
    });
  });

  describe("stream() pipeline", () => {
    it("falls back to complete() when provider has no stream()", async () => {
      const provider = createMockProvider(); // no stream method
      orchestrator = createOrchestrator({ provider });

      const chunks: AIStreamChunk[] = [];
      for await (const chunk of orchestrator.stream(makeRequest("hello"), defaultOpts)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("Hello from mock");
      expect(chunks[0].done).toBe(true);
      expect(chunks[0].usage).toBeDefined();

      // Metrics should include timeToFirstTokenMs
      expect(recordedMetrics).toHaveLength(1);
      expect(recordedMetrics[0].success).toBe(true);
    });

    it("streams chunks from provider.stream()", async () => {
      async function* mockStream(): AsyncIterable<AIStreamChunk> {
        yield { text: "Hello ", done: false };
        yield { text: "world", done: false };
        yield {
          text: "",
          done: true,
          usage: { inputTokens: 5, outputTokens: 10, cost: 0.001 },
        };
      }

      const provider = createMockProvider({
        stream: jest.fn().mockReturnValue(mockStream()),
      });
      orchestrator = createOrchestrator({ provider });

      const chunks: AIStreamChunk[] = [];
      for await (const chunk of orchestrator.stream(makeRequest("hello"), defaultOpts)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0].text).toBe("Hello ");
      expect(chunks[1].text).toBe("world");
      expect(chunks[2].done).toBe(true);
      expect(chunks[2].usage?.inputTokens).toBe(5);

      // Final metrics
      expect(recordedMetrics).toHaveLength(1);
      expect(recordedMetrics[0].success).toBe(true);
      expect(recordedMetrics[0].timeToFirstTokenMs).toBeDefined();
    });

    it("falls back to complete() when stream() throws", async () => {
      const provider = createMockProvider({
        stream: jest.fn().mockImplementation(async function* () {
          throw new AIProviderError("stream broken", "transient");
        }),
      });
      orchestrator = createOrchestrator({ provider });

      const chunks: AIStreamChunk[] = [];
      for await (const chunk of orchestrator.stream(makeRequest("hello"), defaultOpts)) {
        chunks.push(chunk);
      }

      // Should have fallen back to complete()
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("Hello from mock");
      expect(chunks[0].done).toBe(true);
    });
  });

  describe("metrics consistency", () => {
    it("all metrics have required fields", async () => {
      const provider = createMockProvider();
      orchestrator = createOrchestrator({ provider });

      await orchestrator.complete(makeRequest("hello"), defaultOpts);

      const m = recordedMetrics[0];
      expect(m).toHaveProperty("useCase");
      expect(m).toHaveProperty("requestId");
      expect(m).toHaveProperty("model");
      expect(m).toHaveProperty("tier");
      expect(m).toHaveProperty("inputTokens");
      expect(m).toHaveProperty("outputTokens");
      expect(m).toHaveProperty("estimatedCostUsd");
      expect(m).toHaveProperty("latencyMs");
      expect(m).toHaveProperty("success");
      expect(m).toHaveProperty("timestamp");
    });
  });
});
