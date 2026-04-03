/**
 * platform/ai/orchestrator.ts — Central LLM orchestration layer
 *
 * ADR-015: Every AI call goes through this orchestrator.
 * Provides: model tiering, circuit breaker, retry, instrumentation.
 *
 * Usage:
 *   const orchestrator = createOrchestrator();
 *   const response = await orchestrator.complete(request, {
 *     useCase: "safety-classify",
 *     requestId: "abc123",
 *   });
 */

import {
  AIProvider,
  AIRequest,
  AIResponse,
  CircuitState,
  CircuitBreakerConfig,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  OrchestratorOptions,
  AICallMetrics,
} from "./types";
import { AnthropicProvider, AIProviderError } from "./provider";
import { estimateCost, recordMetrics } from "./instrumentation";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG) {
    this.config = config;
  }

  /** Check if the circuit allows a request through */
  canExecute(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.recoveryTimeMs) {
        this.state = "half-open";
        this.successCount = 0;
        return true;
      }
      return false;
    }

    // half-open: allow through for probing
    return true;
  }

  /** Record a successful call */
  recordSuccess(): void {
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenSuccessThreshold) {
        this.state = "closed";
        this.failureCount = 0;
        this.successCount = 0;
      }
      return;
    }
    // In closed state, reset failure count on success
    this.failureCount = 0;
  }

  /** Record a failed call */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Any failure in half-open reopens immediately
      this.state = "open";
      return;
    }

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = "open";
      logger.warn("Circuit breaker opened — AI provider failures exceeded threshold", {
        failureCount: this.failureCount,
        threshold: this.config.failureThreshold,
      });
    }
  }

  /** Get current circuit state — for monitoring and tests */
  getState(): CircuitState {
    // Re-evaluate open → half-open transition
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.recoveryTimeMs) {
        return "half-open";
      }
    }
    return this.state;
  }

  /** Reset the circuit breaker — used in tests */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface Orchestrator {
  /** Send a completion request through the orchestration layer */
  complete(request: AIRequest, options: OrchestratorOptions): Promise<AIResponse>;
  /** Get circuit breaker state — for monitoring */
  getCircuitState(): CircuitState;
  /** Reset circuit breaker — for tests */
  resetCircuit(): void;
}

export interface CreateOrchestratorOptions {
  /** Primary LLM provider — defaults to AnthropicProvider */
  provider?: AIProvider;
  /** Circuit breaker config — defaults to DEFAULT_CIRCUIT_BREAKER_CONFIG */
  circuitBreakerConfig?: CircuitBreakerConfig;
}

export function createOrchestrator(options?: CreateOrchestratorOptions): Orchestrator {
  const provider = options?.provider ?? new AnthropicProvider();
  const circuitBreaker = new CircuitBreaker(options?.circuitBreakerConfig);

  return {
    async complete(request: AIRequest, opts: OrchestratorOptions): Promise<AIResponse> {
      // Apply tier override if specified
      const effectiveRequest = opts.tierOverride
        ? { ...request, tier: opts.tierOverride }
        : request;

      // Circuit breaker check
      if (!circuitBreaker.canExecute()) {
        const error = new AIProviderError(
          "Circuit breaker is open — AI provider is unavailable",
          "transient"
        );
        recordFailureMetrics(effectiveRequest, opts, 0, error.message);
        throw error;
      }

      const startTime = Date.now();

      try {
        const response = await provider.complete(effectiveRequest);
        const latencyMs = Date.now() - startTime;

        circuitBreaker.recordSuccess();

        // Record success metrics
        const metrics: AICallMetrics = {
          useCase: opts.useCase,
          requestId: opts.requestId,
          model: response.model,
          tier: effectiveRequest.tier,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          estimatedCostUsd: estimateCost(
            effectiveRequest.tier,
            response.usage.inputTokens,
            response.usage.outputTokens
          ),
          latencyMs,
          cached: false,
          success: true,
          timestamp: new Date().toISOString(),
        };
        recordMetrics(metrics);

        return response;
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : "Unknown error";

        // Only count transient errors against the circuit breaker
        const isTransient = err instanceof AIProviderError && err.kind === "transient";
        if (isTransient) {
          circuitBreaker.recordFailure();
        }

        recordFailureMetrics(effectiveRequest, opts, latencyMs, errorMessage);
        throw err;
      }
    },

    getCircuitState(): CircuitState {
      return circuitBreaker.getState();
    },

    resetCircuit(): void {
      circuitBreaker.reset();
    },
  };
}

function recordFailureMetrics(
  request: AIRequest,
  opts: OrchestratorOptions,
  latencyMs: number,
  error: string
): void {
  const metrics: AICallMetrics = {
    useCase: opts.useCase,
    requestId: opts.requestId,
    model: "unknown",
    tier: request.tier,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    latencyMs,
    cached: false,
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };
  recordMetrics(metrics);
}

// ---------------------------------------------------------------------------
// Singleton — shared orchestrator instance for the application
// ---------------------------------------------------------------------------

let defaultOrchestrator: Orchestrator | null = null;

/** Get the shared orchestrator instance — lazily created */
export function getOrchestrator(): Orchestrator {
  if (!defaultOrchestrator) {
    defaultOrchestrator = createOrchestrator();
  }
  return defaultOrchestrator;
}

/**
 * Replace the default orchestrator — used in tests to inject mocks.
 * Returns the previous orchestrator for cleanup.
 */
export function setOrchestrator(orchestrator: Orchestrator): Orchestrator | null {
  const previous = defaultOrchestrator;
  defaultOrchestrator = orchestrator;
  return previous;
}
