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
import { PROBE_FAILED, logCaught } from "@/platform/observability/caught-error";

/** The database probe's own timeout: its detail says so, in this module's words. */
class DatabaseProbeTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Database did not answer within ${timeoutMs}ms`);
  }
}

// ---------------------------------------------------------------------------
// Health Registry — aggregates probes into a report
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;

export class HealthRegistry {
  private readonly probes: { probe: HealthProbe; required: boolean }[] = [];
  private readonly version: string;

  constructor(version: string) {
    this.version = version;
  }

  /**
   * Register a health probe. Duplicate names are rejected. `required` (default true): an
   * unhealthy result makes the whole report unhealthy; an optional probe's makes it degraded
   * (ADR-056 D4).
   */
  register(probe: HealthProbe, options: { readonly required?: boolean } = {}): void {
    if (this.probes.some((p) => p.probe.name === probe.name)) {
      logger.warn(`Health probe '${probe.name}' already registered — skipping duplicate`);
      return;
    }
    this.probes.push({ probe, required: options.required ?? true });
  }

  /** Run all probes and return an aggregated report. */
  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HealthReport> {
    const checks = await Promise.all(
      this.probes.map(async ({ probe, required }) => ({
        ...(await this.runProbe(probe, timeoutMs)),
        required,
      }))
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
    return this.probes.map((p) => p.probe.name);
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
      logCaught(logger, "Health probe failed", err, { probe: probe.name }, "warn");
      return {
        name: probe.name,
        status: "unhealthy",
        detail: PROBE_FAILED,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private worstStatus(checks: HealthCheckResult[]): HealthStatus {
    if (checks.length === 0) return "healthy";
    if (checks.some((c) => c.status === "unhealthy" && c.required !== false)) {
      return "unhealthy";
    }
    if (checks.some((c) => c.status !== "healthy")) return "degraded";
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
        timer = setTimeout(() => reject(new DatabaseProbeTimeout(timeoutMs)), timeoutMs);
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
      logCaught(logger, "Health probe failed", err, { probe: this.name }, "warn");
      return {
        name: this.name,
        status: "unhealthy",
        latencyMs: Date.now() - start,
        // Its own timeout says so (this module's words); any other failure's text is logged.
        detail:
          err instanceof DatabaseProbeTimeout
            ? `Database did not answer within ${err.timeoutMs}ms`
            : PROBE_FAILED,
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
 *
 * @deprecated TASK-197 (audit D-2): its empty-body request answers 400 for a retired model and
 * for an exhausted credit balance alike, and both are reported healthy. Readiness registers
 * createAIProviderReadinessProbe (platform/ai/readiness-probe.ts) instead — the deployed key and
 * models, max_tokens 1, cached. Kept only for consumers that construct it.
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
      logCaught(logger, "Health probe failed", err, { probe: this.name }, "warn");
      return {
        name: this.name,
        status: "unhealthy",
        latencyMs: Date.now() - start,
        detail: PROBE_FAILED,
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
      logCaught(logger, "Health probe failed", err, { probe: this.name }, "warn");
      return {
        name: this.name,
        status: "unhealthy",
        latencyMs: Date.now() - start,
        detail: PROBE_FAILED,
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
 *
 * TASK-197 review round 1 (M-1), with `options.budgetMs`: the probe gets its own, longer budget,
 * independent of the readiness race (3 s per probe). A check answers within the caller's timeout
 * whatever the probe does: the cached result while a refresh runs, or — before any result —
 * "degraded: check pending", never a timeout read as "unhealthy". `options.failureTtlMs` keeps a
 * result that is not healthy (a timeout, no answer) only that long, so a cold start's slow call
 * is retried soon rather than reported for the whole interval. Round 2: a check in flight longer
 * than twice its budget is abandoned (answered degraded, never cached), and a result that took
 * that long is not cached; the routes keep the function alive for running checks (`after()`).
 */
/**
 * The paid checks still running, kept per process (shared by bundle copies, ADR-032), so a route
 * can keep its function alive until they settle (`settlePendingProbes`, called from `after()` by
 * the readiness and health routes — TASK-197 review round 2). On a serverless platform a check
 * left running after the response is otherwise frozen with the function, and its "timeout" on
 * the next thaw is not the provider's.
 */
function pendingChecks(): Set<Promise<unknown>> {
  const key = "platform.observability.pending-probe-checks";
  const g = globalThis as unknown as Record<string, Set<Promise<unknown>> | undefined>;
  return (g[key] ??= new Set());
}

/** Resolves when every paid check running now has settled (never rejects). */
export async function settlePendingProbes(): Promise<void> {
  await Promise.allSettled([...pendingChecks()]);
}

export class CachedHealthProbe implements HealthProbe {
  readonly name: string;
  private last: { result: HealthCheckResult; at: number } | null = null;
  private inFlight: { promise: Promise<HealthCheckResult>; startedAt: number } | null =
    null;

  constructor(
    private readonly probe: HealthProbe,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly options: {
      readonly budgetMs?: number;
      readonly failureTtlMs?: number;
    } = {}
  ) {
    if (!(ttlMs > 0)) throw new Error("CachedHealthProbe needs a positive ttlMs");
    this.name = probe.name;
  }

  private fresh(): boolean {
    if (!this.last) return false;
    const ttl =
      this.last.result.status === "healthy"
        ? this.ttlMs
        : Math.min(this.ttlMs, this.options.failureTtlMs ?? this.ttlMs);
    return this.now() - this.last.at < ttl;
  }

  /**
   * How long a check may stay in flight (round 2): twice its budget. Past it, it is abandoned —
   * its answer is never cached (it was frozen, or hung) — and the next check starts afresh.
   */
  private maxAgeMs(): number | null {
    return this.options.budgetMs === undefined ? null : 2 * this.options.budgetMs;
  }

  private refresh(timeoutMs?: number): Promise<HealthCheckResult> {
    if (this.inFlight) return this.inFlight.promise;
    const startedAt = this.now();
    const flight = { startedAt } as {
      promise: Promise<HealthCheckResult>;
      startedAt: number;
    };
    flight.promise = this.probe
      .check(this.options.budgetMs ?? timeoutMs)
      .then((result) => {
        const maxAge = this.maxAgeMs();
        // A superseded check, or one that took longer than twice its budget (the function was
        // frozen while it ran), answers its caller but is not cached.
        if (
          this.inFlight === flight &&
          (maxAge === null || this.now() - startedAt <= maxAge)
        ) {
          this.last = { result, at: this.now() };
        }
        return result;
      });
    const settled = flight.promise.finally(() => {
      if (this.inFlight === flight) this.inFlight = null;
      pendingChecks().delete(settled);
    });
    settled.catch(() => undefined);
    pendingChecks().add(settled);
    this.inFlight = flight;
    return flight.promise;
  }

  async check(timeoutMs?: number): Promise<HealthCheckResult> {
    if (this.last && this.fresh()) return this.last.result;
    const maxAge = this.maxAgeMs();
    if (
      this.inFlight &&
      maxAge !== null &&
      this.now() - this.inFlight.startedAt > maxAge
    ) {
      // Abandoned: answered degraded — no answer is not proof of failure, and an optional
      // probe never takes an instance out of rotation (ADR-056 D4; round 3, N4) — never cached;
      // a new check starts.
      this.inFlight = null;
      this.refresh(timeoutMs).catch(() => undefined);
      return {
        name: this.name,
        status: "degraded",
        detail: `check did not finish within ${maxAge} ms`,
        checkedAt: new Date().toISOString(),
      };
    }
    const running = this.refresh(timeoutMs);
    if (this.options.budgetMs === undefined) return running;
    // Answer within the caller's bound (a margin under it), whatever the probe's own budget.
    const answerWithin = Math.max(0, (timeoutMs ?? DEFAULT_TIMEOUT_MS) - 250);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), answerWithin);
      (timer as { unref?: () => void }).unref?.();
    });
    const settled = await Promise.race([running, pending]);
    clearTimeout(timer);
    if (settled) return settled;
    if (this.last) return this.last.result;
    return {
      name: this.name,
      status: "degraded",
      detail: "check pending: the provider has not answered yet",
      checkedAt: new Date().toISOString(),
    };
  }
}
