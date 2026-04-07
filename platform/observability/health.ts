/**
 * platform/observability/health.ts — Dependency health checking
 *
 * ADR-014: Know before users tell you something is broken.
 *
 * HealthRegistry aggregates multiple HealthProbe implementations
 * into a single HealthReport. Built-in probes for Supabase and
 * LLM provider availability.
 *
 * Consumers register probes for their specific dependencies:
 *   registry.register(new RedisHealthProbe(redisUrl));
 *   registry.register(new S3HealthProbe(bucket));
 */

import type { HealthProbe, HealthCheckResult, HealthReport, HealthStatus } from "./types";
import { logger } from "@/lib/logger";

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
 * SupabaseHealthProbe — pings the Supabase REST API.
 *
 * Checks that the Supabase instance is reachable and responding.
 * Does NOT verify table access or RLS policies — that's an integration test.
 */
export class SupabaseHealthProbe implements HealthProbe {
  readonly name = "supabase";
  private readonly url: string;
  private readonly key: string;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.url = supabaseUrl;
    this.key = supabaseKey;
  }

  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${this.url}/rest/v1/`, {
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      return {
        name: this.name,
        status: response.ok ? "healthy" : "degraded",
        latencyMs,
        detail: response.ok ? "OK" : `HTTP ${response.status}`,
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

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Anthropic: POST /v1/messages with empty body returns 400, not 401.
      // A 400 means the API key is valid and the service is reachable.
      // A 401 means invalid key. A network error means service is down.
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
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

      const response = await fetch(this.url, {
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
