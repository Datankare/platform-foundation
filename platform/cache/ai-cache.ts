/**
 * AI Cache Utilities — GenAI-native cache layer.
 *
 * GenAI Principles satisfied:
 *   P4 — AI responses are cached and retrieval-augmented
 *   P2 — Every AI call instrumented (cache hit = zero cost tracked)
 *   P5 — AI cost tracked (cache hits reduce cost, tracked in metrics)
 *   P9 — Observability (hit/miss ratio reported to MetricsSink)
 *
 * Wraps the generic CacheProvider with AI-specific concerns:
 * - Deterministic cache keys from model + prompt + parameters
 * - Hit/miss metrics reported to observability MetricsSink
 * - Cost savings tracked (cached response = zero tokens, zero cost)
 *
 * Usage:
 *   import { getAICache } from "@/platform/cache";
 *   const cached = await aiCache.get(request);
 *   if (cached) return cached; // zero-cost response
 *   const response = await orchestrator.complete(request, opts);
 *   await aiCache.set(request, response);
 *
 * @module platform/cache
 * @see ADR-015 GenAI-Native Stack
 * @see ADR-017 GenAI Surface Map — P4 (cached responses)
 */

import { createHash } from "node:crypto";
import type { CacheProvider } from "./types";
import { memoryPartition } from "@/platform/tenancy/partition";
import type { AIRequest, AIResponse } from "@/platform/ai";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

// ---------------------------------------------------------------------------
// Cache key generation
// ---------------------------------------------------------------------------

/**
 * Build a deterministic cache key from an AI request, within the current tenant (ADR-053 D6).
 *
 * Key components: tenant + model tier + system prompt + messages + parameters + tools, hashed
 * with SHA-256 over an unambiguous encoding. A cache hit serves one request's response to
 * another, so the key must not collide: it was a 32-bit FNV hash, where unrelated prompts share a
 * key after a few tens of thousands of entries, and it named no tenant.
 */
export function buildAICacheKey(request: AIRequest): string {
  const material = JSON.stringify([
    request.tier,
    request.system ?? "",
    request.messages.map((m: { role: string; content: string | unknown }) => [
      m.role,
      m.content,
    ]),
    request.temperature ?? null,
    request.maxTokens ?? null,
    request.tools && request.tools.length > 0 ? request.tools : null,
  ]);
  const digest = createHash("sha256").update(material).digest("base64url");
  return `ai:${memoryPartition()}:${digest}`;
}

// ---------------------------------------------------------------------------
// AI Cache — wraps CacheProvider with AI semantics
// ---------------------------------------------------------------------------

/** Metrics callback for observability integration */
export interface AICacheMetricsCallback {
  onCacheHit(key: string, useCase: string, savedCostUsd: number): void;
  onCacheMiss(key: string, useCase: string): void;
}

/** Configuration for AI cache */
export interface AICacheConfig {
  /** Underlying cache provider */
  cache: CacheProvider;
  /** TTL in seconds for cached AI responses. Default: 3600 (1 hour). */
  defaultTTLSeconds?: number;
  /** TTL overrides by use case. */
  ttlByUseCase?: Record<string, number>;
  /** Whether caching is enabled. Default: true. */
  enabled?: boolean;
  /** Metrics callback for hit/miss tracking. */
  metrics?: AICacheMetricsCallback;
}

/**
 * AI-specific cache wrapper.
 *
 * Handles prompt-hash keying, TTL by use case, hit/miss metrics,
 * and cost-savings tracking. Consumers use this, not raw CacheProvider,
 * for AI response caching.
 */
export class AICache {
  private readonly cache: CacheProvider;
  private readonly defaultTTL: number;
  private readonly ttlByUseCase: Record<string, number>;
  private readonly enabled: boolean;
  private readonly metrics: AICacheMetricsCallback | null;

  // Counters for inspection (testing + health)
  private _hits = 0;
  private _misses = 0;

  constructor(config: AICacheConfig) {
    this.cache = config.cache;
    this.defaultTTL = config.defaultTTLSeconds ?? 3600;
    this.ttlByUseCase = config.ttlByUseCase ?? {};
    this.enabled = config.enabled ?? true;
    this.metrics = config.metrics ?? null;
  }

  /**
   * Look up a cached AI response.
   * Returns the cached AIResponse or null if not found.
   */
  async get(request: AIRequest, useCase: string): Promise<AIResponse | null> {
    if (!this.enabled) return null;

    const key = buildAICacheKey(request);

    try {
      const cached = await this.cache.get<AIResponse>(key);

      if (cached) {
        this._hits++;
        // Estimate cost savings from the cached response
        const savedCost = this.estimateSavedCost(cached);
        this.metrics?.onCacheHit(key, useCase, savedCost);
        return cached;
      }

      this._misses++;
      this.metrics?.onCacheMiss(key, useCase);
      return null;
    } catch {
      // Cache failure is not request failure — miss, continue
      this._misses++;
      this.metrics?.onCacheMiss(key, useCase);
      return null;
    }
  }

  /**
   * Store an AI response in cache.
   * TTL is determined by use case or default.
   */
  async set(request: AIRequest, response: AIResponse, useCase: string): Promise<void> {
    if (!this.enabled) return;

    const key = buildAICacheKey(request);
    const ttl = this.ttlByUseCase[useCase] ?? this.defaultTTL;

    try {
      await this.cache.set(key, response, { ttlSeconds: ttl });
    } catch {
      // Cache write failure is non-fatal — log but don't throw
    }
  }

  /**
   * Invalidate cached response for a specific request.
   */
  async invalidate(request: AIRequest): Promise<void> {
    const key = buildAICacheKey(request);
    await this.cache.delete(key);
  }

  /**
   * Clear all AI cached responses.
   */
  async clearAll(): Promise<void> {
    await this.cache.clear();
  }

  /**
   * Delete all cached AI responses for a specific user.
   * Used by GDPR purge pipeline.
   *
   * NOTE: With hash-based keys, we can't enumerate per-user entries
   * in the generic cache. This clears the entire AI cache namespace.
   * For per-user granularity, a user-keyed cache design is needed (Phase 4).
   */
  async purgeUserData(_userId: string): Promise<number> {
    // Phase 2: Clear entire AI cache (conservative approach)
    // Phase 4: User-keyed cache enables per-user purge
    await this.cache.clear();
    return 0; // Can't count hash-keyed entries
  }

  /** Get hit/miss stats */
  get stats(): { hits: number; misses: number; hitRate: number } {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }

  /**
   * Estimate the cost that was saved by serving from cache.
   * Uses the token counts from the original response.
   */
  private estimateSavedCost(response: AIResponse): number {
    // Rough cost estimate: $0.25/MTok input, $1.25/MTok output (Haiku)
    // Actual cost comes from estimateCost() in instrumentation.ts
    const inputCost = (response.usage.inputTokens / 1_000_000) * 0.25;
    const outputCost = (response.usage.outputTokens / 1_000_000) * 1.25;
    return parseFloat((inputCost + outputCost).toFixed(6));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const AICACHE_KEY = "platform.cache.aiCache";
function readAiCacheInstance(): AICache | null {
  return getSingleton<AICache | null>(AICACHE_KEY, () => null);
}
function writeAiCacheInstance(next: AICache | null): void {
  setSingleton<AICache | null>(AICACHE_KEY, next);
}

/**
 * Get the singleton AI cache.
 * Requires the generic cache to be available (auto-detected from env).
 */
export function getAICache(config?: Partial<AICacheConfig>): AICache {
  const existing = readAiCacheInstance();
  if (existing) return existing;
  // Lazy import to avoid circular dependency at module load
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCache } = require("./index") as { getCache: () => CacheProvider };
  const created = new AICache({
    cache: config?.cache ?? getCache(),
    defaultTTLSeconds: config?.defaultTTLSeconds,
    ttlByUseCase: config?.ttlByUseCase,
    enabled: config?.enabled,
    metrics: config?.metrics,
  });
  writeAiCacheInstance(created);
  return created;
}

/** Reset singleton (testing only) */
export function resetAICache(): void {
  writeAiCacheInstance(null);
}
