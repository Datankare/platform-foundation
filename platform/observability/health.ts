/**
 * platform/observability/health.ts — Dependency health checking
 *
 * ADR-014: Know before users tell you something is broken.
 *
 * HealthRegistry aggregates multiple HealthProbe implementations
 * into a single HealthReport. Built-in probes for database (Postgres, through platform/data)
 * and LLM provider availability.
 *
 * Consumers register probes for their specific dependencies:
 *   registry.register(new RedisHealthProbe(redisUrl));
 *   registry.register(new S3HealthProbe(bucket));
 */

import type { HealthProbe, HealthCheckResult, HealthReport, HealthStatus } from "./types";
import { logger } from "@/lib/logger";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { hasDatabase, withPlatformTx } from "@/platform/data";

// ---------------------------------------------------------------------------
// Health Registry — aggregates probes into a report
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;

export class HealthRegistry {
  private readonly probes: HealthProbe[] = [];
  private readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  /** Register a health probe. Duplicate names are rejected. */
  register(probe: HealthProbe): void {
    if (this.probes.some((p) => p.name === probe.name)) {
      logger.warn(`Health probe '${probe.name}' already registered — skipping duplicate`);
      return;
    }
    this.probes.push(probe);
  }

  /** Run all probes and return an aggregated report. */
  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HealthReport> {
    const checks = await Promise.all(
      this.probes.map((probe) => this.runProbe(probe, timeoutMs))
    );

    const status = this.worstStatus(checks);

    return {
      status,
      checks,
      timestamp: new Date().toISOString(),
      version: this.version,
    };
  }

  /** Get registered probe names — for tests. */
  getProbeNames(): readonly string[] {
    return this.probes.map((p) => p.name);
  }

  private async runProbe(
    probe: HealthProbe,
    timeoutMs: number
  ): Promise<HealthCheckResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<HealthCheckResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              name: probe.name,
              status: "unhealthy",
              detail: `Health check timed out after ${timeoutMs}ms`,
              checkedAt: new Date().toISOString(),
            }),
          timeoutMs
        );
      });

      const result = await Promise.race([probe.check(timeoutMs), timeoutPromise]);
      clearTimeout(timer);
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      return {
        name: probe.name,
        status: "unhealthy",
        detail: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private worstStatus(checks: HealthCheckResult[]): HealthStatus {
    if (checks.length === 0) return "healthy";
    if (checks.some((c) => c.status === "unhealthy")) return "unhealthy";
    if (checks.some((c) => c.status === "degraded")) return "degraded";
    return "healthy";
  }
}

// ---------------------------------------------------------------------------
// Built-in probes
// ---------------------------------------------------------------------------

/**
 * PostgresHealthProbe — runs `select 1` on the database through platform/data.
 *
 * Checks that the database is reachable and answering, as the request role in a platform
 * transaction (no tenant needed, no table read). Does NOT verify table access or RLS
 * policies — that's an integration test. Unhealthy when no database is configured, when the
 * query fails, or when it does not answer within `timeoutMs`.
 */
export class PostgresHealthProbe implements HealthProbe {
  readonly name = "database";

  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!hasDatabase()) {
      return {
        name: this.name,
        status: "unhealthy",
        latencyMs: 0,
        detail: "No database configured (DATABASE_URL)",
        checkedAt: new Date().toISOString(),
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Database did not answer within ${timeoutMs}ms`)),
          timeoutMs
        );
      });
      await Promise.race([withPlatformTx((tx) => tx.query("select 1")), timedOut]);
      return {
        name: this.name,
        status: "healthy",
        latencyMs: Date.now() - start,
        detail: "OK",
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        name: this.name,
        status: "unhealthy",
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * LLMProviderHealthProbe — checks that the configured LLM provider is reachable.
 *
 * Makes a lightweight request to verify API key validity and service availability.
 * Does NOT run an actual completion — that would be expensive and slow.
 */
export class LLMProviderHealthProbe implements HealthProbe {
  readonly name = "llm-provider";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HealthCheckResult> {
    if (!this.apiKey) {
      return {
        name: this.name,
        status: "unhealthy",
        detail: "No API key configured",
        checkedAt: new Date().toISOString(),
      };
    }

    /* istanbul ignore next -- requires live Anthropic API */
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Anthropic: POST /v1/messages with empty body returns 400, not 401.
      // A 400 means the API key is valid and the service is reachable.
      // A 401 means invalid key. A network error means service is down.
      const response = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      if (response.status === 401) {
        return {
          name: this.name,
          status: "unhealthy",
          latencyMs,
          detail: "Invalid API key",
          checkedAt: new Date().toISOString(),
        };
      }

      // 400 = reachable + valid key, just malformed request (expected)
      return {
        name: this.name,
        status: response.status === 400 || response.ok ? "healthy" : "degraded",
        latencyMs,
        detail: `API reachable (HTTP ${response.status})`,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        name: this.name,
        status: "unhealthy",
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

/**
 * HttpHealthProbe — generic HTTP health check for any endpoint.
 *
 * Consumers use this for custom dependencies:
 *   new HttpHealthProbe("redis-api", "http://redis-rest:6379/health")
 *   new HttpHealthProbe("search-service", "http://search:9200/_cluster/health")
 */
export class HttpHealthProbe implements HealthProbe {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(name: string, url: string, headers: Record<string, string> = {}) {
    this.name = name;
    this.url = url;
    this.headers = headers;
  }

  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetchWithTimeout(this.url, {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        headers: this.headers,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      return {
        name: this.name,
        status: response.ok ? "healthy" : "degraded",
        latencyMs,
        detail: `HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        name: this.name,
        status: "unhealthy",
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

/**
 * CachedHealthProbe — runs a costly probe at most once per `ttlMs` and shares that result.
 *
 * /api/health is public and rate-limit-exempt, so a probe that calls a paid provider (song
 * identification bills per call) turned every health request into a paid call anyone could
 * repeat (audit X-13). Wrapped, the paid call happens at most once per interval per instance;
 * concurrent checks share one in-flight call; the reported result carries when it was taken.
 */
export class CachedHealthProbe implements HealthProbe {
  readonly name: string;
  private last: { result: HealthCheckResult; at: number } | null = null;
  private inFlight: Promise<HealthCheckResult> | null = null;

  constructor(
    private readonly probe: HealthProbe,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!(ttlMs > 0)) throw new Error("CachedHealthProbe needs a positive ttlMs");
    this.name = probe.name;
  }

  async check(timeoutMs?: number): Promise<HealthCheckResult> {
    if (this.last && this.now() - this.last.at < this.ttlMs) return this.last.result;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe
      .check(timeoutMs)
      .then((result) => {
        this.last = { result, at: this.now() };
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
