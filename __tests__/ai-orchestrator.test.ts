/**
 * __tests__/ai-orchestrator.test.ts — Orchestrator + circuit breaker tests
 *
 * Tests: model tiering, circuit breaker state transitions,
 * instrumentation recording, error handling, singleton management.
 */

import {
  createOrchestrator,
  CircuitBreaker,
  getOrchestrator,
  setOrchestrator,
  clearMetrics,
  getRecentMetrics,
  AIProviderError,
} from "@/platform/ai";
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  OrchestratorOptions,
} from "@/platform/ai";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function createMockProvider(
  overrides?: Partial<AIProvider> & {
    completeFn?: (req: AIRequest) => Promise<AIResponse>;
  }
): AIProvider {
  const defaultResponse: AIResponse = {
    content: [{ type: "text", text: "Hello" }],
    model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: "end_turn",
  };

  return {
    name: "mock",
    complete:
      overrides?.completeFn ?? jest.fn().mockResolvedValue(overrides ?? defaultResponse),
    ...overrides,
  };
}

const DEFAULT_OPTS: OrchestratorOptions = {
  useCase: "test",
  requestId: "test-123",
};

const FAST_REQUEST: AIRequest = {
  tier: "fast",
  messages: [{ role: "user", content: "test" }],
  maxTokens: 64,
};

const STANDARD_REQUEST: AIRequest = {
  tier: "standard",
  system: "You are helpful.",
  messages: [{ role: "user", content: "test" }],
  maxTokens: 1024,
};

beforeEach(() => {
  clearMetrics();
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("closed");
    expect(cb.canExecute()).toBe(true);
  });

  it("opens after failure threshold", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeMs: 1000,
      halfOpenSuccessThreshold: 1,
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.canExecute()).toBe(false);
  });

  it("resets failure count on success in closed state", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeMs: 1000,
      halfOpenSuccessThreshold: 1,
    });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    // Should still be closed — success reset the count
    expect(cb.getState()).toBe("closed");
  });

  it("transitions to half-open after recovery time", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeMs: 50,
      halfOpenSuccessThreshold: 1,
    });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    // Wait for recovery
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.getState()).toBe("half-open");
        expect(cb.canExecute()).toBe(true);
        resolve();
      }, 60);
    });
  });

  it("closes from half-open after success threshold", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeMs: 10,
      halfOpenSuccessThreshold: 2,
    });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.canExecute()).toBe(true); // triggers half-open
        cb.recordSuccess();
        // Still half-open — need 2 successes
        expect(cb.getState()).toBe("half-open");
        cb.recordSuccess();
        expect(cb.getState()).toBe("closed");
        resolve();
      }, 20);
    });
  });

  it("reopens from half-open on failure", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeMs: 10,
      halfOpenSuccessThreshold: 2,
    });
    cb.recordFailure();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canExecute(); // triggers half-open transition
        cb.recordFailure(); // fail in half-open → reopen
        expect(cb.getState()).toBe("open");
        resolve();
      }, 20);
    });
  });

  it("reset restores closed state", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeMs: 60_000,
      halfOpenSuccessThreshold: 1,
    });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    cb.reset();
    expect(cb.getState()).toBe("closed");
    expect(cb.canExecute()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

describe("createOrchestrator", () => {
  it("completes a request and records metrics", async () => {
    const mockResponse: AIResponse = {
      content: [{ type: "text", text: "Safe" }],
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 100, outputTokens: 20 },
      stopReason: "end_turn",
    };

    const provider = createMockProvider({
      completeFn: jest.fn().mockResolvedValue(mockResponse),
    });
    const orch = createOrchestrator({ provider });

    const result = await orch.complete(FAST_REQUEST, DEFAULT_OPTS);

    expect(result.content[0]).toEqual({ type: "text", text: "Safe" });
    expect(result.usage.inputTokens).toBe(100);

    // Verify metrics recorded
    const metrics = getRecentMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].useCase).toBe("test");
    expect(metrics[0].success).toBe(true);
    expect(metrics[0].model).toBe("claude-haiku-4-5-20251001");
    expect(metrics[0].estimatedCostUsd).toBeGreaterThan(0);
    expect(metrics[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("passes tier to provider", async () => {
    const completeFn = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-20250514",
      usage: { inputTokens: 200, outputTokens: 100 },
      stopReason: "end_turn",
    });
    const provider = createMockProvider({ completeFn });
    const orch = createOrchestrator({ provider });

    await orch.complete(STANDARD_REQUEST, DEFAULT_OPTS);

    expect(completeFn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "standard" })
    );
  });

  it("applies tierOverride from options", async () => {
    const completeFn = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-20250514",
      usage: { inputTokens: 200, outputTokens: 100 },
      stopReason: "end_turn",
    });
    const provider = createMockProvider({ completeFn });
    const orch = createOrchestrator({ provider });

    await orch.complete(FAST_REQUEST, { ...DEFAULT_OPTS, tierOverride: "standard" });

    expect(completeFn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "standard" })
    );
  });

  it("records failure metrics on error", async () => {
    const provider = createMockProvider({
      completeFn: jest.fn().mockRejectedValue(new Error("Network fail")),
    });
    const orch = createOrchestrator({ provider });

    await expect(orch.complete(FAST_REQUEST, DEFAULT_OPTS)).rejects.toThrow(
      "Network fail"
    );

    const metrics = getRecentMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].success).toBe(false);
    expect(metrics[0].error).toBe("Network fail");
  });

  it("opens circuit breaker on transient errors", async () => {
    const provider = createMockProvider({
      completeFn: jest
        .fn()
        .mockRejectedValue(new AIProviderError("503 Service Unavailable", "transient")),
    });
    const orch = createOrchestrator({
      provider,
      circuitBreakerConfig: {
        failureThreshold: 2,
        recoveryTimeMs: 60_000,
        halfOpenSuccessThreshold: 1,
      },
    });

    // First failure
    await expect(orch.complete(FAST_REQUEST, DEFAULT_OPTS)).rejects.toThrow();
    expect(orch.getCircuitState()).toBe("closed");

    // Second failure — opens circuit
    await expect(orch.complete(FAST_REQUEST, DEFAULT_OPTS)).rejects.toThrow();
    expect(orch.getCircuitState()).toBe("open");

    // Third call — circuit open, fails immediately without calling provider
    await expect(orch.complete(FAST_REQUEST, DEFAULT_OPTS)).rejects.toThrow(
      "Circuit breaker is open"
    );
  });

  it("does not count permanent errors against circuit breaker", async () => {
    const provider = createMockProvider({
      completeFn: jest
        .fn()
        .mockRejectedValue(new AIProviderError("Invalid API key", "permanent")),
    });
    const orch = createOrchestrator({
      provider,
      circuitBreakerConfig: {
        failureThreshold: 2,
        recoveryTimeMs: 60_000,
        halfOpenSuccessThreshold: 1,
      },
    });

    await expect(orch.complete(FAST_REQUEST, DEFAULT_OPTS)).rejects.toThrow();
    await expect(orch.complete(FAST_REQUEST, DEFAULT_OPTS)).rejects.toThrow();
    await expect(orch.complete(FAST_REQUEST, DEFAULT_OPTS)).rejects.toThrow();

    // Circuit should still be closed — permanent errors don't trip it
    expect(orch.getCircuitState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

describe("getOrchestrator / setOrchestrator", () => {
  afterEach(() => {
    // Reset to null so tests don't leak
    setOrchestrator(null as unknown as ReturnType<typeof createOrchestrator>);
  });

  it("getOrchestrator returns a singleton", () => {
    const a = getOrchestrator();
    const b = getOrchestrator();
    expect(a).toBe(b);
  });

  it("setOrchestrator replaces the singleton and returns previous", () => {
    const original = getOrchestrator();
    const mock = createOrchestrator({
      provider: createMockProvider(),
    });
    const previous = setOrchestrator(mock);
    expect(previous).toBe(original);
    expect(getOrchestrator()).toBe(mock);
  });
});
