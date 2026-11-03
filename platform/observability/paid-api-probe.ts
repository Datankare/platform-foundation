/**
 * platform/observability/paid-api-probe.ts — readiness for a paid API, by a call that costs
 * (next to) nothing (TASK-197, audit D-2)
 *
 * Readiness checked the database, the cache and the Cognito pool's shape, but nothing told an
 * operator that the AI key was revoked, its credit balance exhausted, a model retired (TASK-186),
 * the Google key restricted or billing off, or the rate-limit store's token rotated — the first
 * sign was users' failed requests. A PaidApiProbe makes the provider's cheapest real call with
 * the DEPLOYED credential and classifies the answer with the platform's table
 * (platform/errors/external-service.ts):
 *
 *   healthy     the call succeeded (and `verify`, when given, found nothing wrong);
 *   unhealthy   a failure a person must fix — a refused credential, an exhausted quota, a retired
 *               model — or no answer at all;
 *   degraded    throttled or overloaded: the provider is there, just busy.
 *
 * Not configured (no key, the provider not selected) is healthy: there is nothing to probe.
 * These probes are optional (ADR-056 D4): an unhealthy one makes readiness "degraded" — still
 * serving, so one provider's outage cannot take every instance out of rotation — and readiness
 * reports it to the error reporter when it changes (readiness.ts reportProbeProblems). Wrap a
 * probe that is billed in CachedHealthProbe (audit X-13): readiness is public and unthrottled.
 *
 * @module platform/observability
 */

import {
  ALERTING_REASONS,
  classifyHttpFailure,
  type ExternalFailureReason,
} from "@/platform/errors/external-service";
import type { HealthCheckResult, HealthProbe, HealthStatus } from "./types";

/**
 * How a paid probe is cached (TASK-197 review round 1, M-1): its own 15 s budget, independent of
 * readiness's 3 s race (readiness gets the cached answer, or "pending"); a result that is not
 * healthy — a timeout, no answer — kept 60 s only.
 */
export const PAID_PROBE_CACHE = Object.freeze({ budgetMs: 15_000, failureTtlMs: 60_000 });

/** One call the probe makes; several (one per model, say) are each made. */
export interface PaidApiCall {
  /** What the call checks, for the detail line ("fast: claude-haiku-4-5"). */
  readonly label: string;
  /** Make the call within `signal`. */
  readonly call: (signal: AbortSignal) => Promise<Response>;
  /** What a 404 means here (a model endpoint: a retired model). */
  readonly notFound?: ExternalFailureReason;
  /** Read a successful answer; a string is the problem found (a voice that no longer exists). */
  readonly verify?: (res: Response) => Promise<string | null>;
  /** Refine the classification of a failed answer (an exhausted balance as quota, say). */
  readonly classify?: (status: number, body: string) => ExternalFailureReason;
}

export interface PaidApiProbeOptions {
  readonly name: string;
  /** Null when there is nothing to probe (not selected, no credential): healthy, said so. */
  readonly calls: () => readonly PaidApiCall[] | null;
  readonly now?: () => number;
}

const RANK: Readonly<Record<HealthStatus, number>> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

/** The status a failure reason earns: unhealthy when a person must act, else degraded. */
export function statusForReason(reason: ExternalFailureReason): HealthStatus {
  return ALERTING_REASONS.has(reason) || reason === "rejected" ? "unhealthy" : "degraded";
}

export class PaidApiProbe implements HealthProbe {
  readonly name: string;

  constructor(private readonly options: PaidApiProbeOptions) {
    this.name = options.name;
  }

  async check(timeoutMs = 3_000): Promise<HealthCheckResult> {
    const now = this.options.now ?? Date.now;
    const start = now();
    const calls = this.options.calls();
    const at = () => new Date().toISOString();
    if (calls === null) {
      return {
        name: this.name,
        status: "healthy",
        latencyMs: 0,
        detail: "not configured: nothing to probe",
        checkedAt: at(),
      };
    }
    const outcomes = await Promise.all(
      calls.map(async (c): Promise<{ status: HealthStatus; detail: string }> => {
        const signal = AbortSignal.timeout(timeoutMs);
        try {
          const res = await c.call(signal);
          if (res.ok) {
            const problem = c.verify ? await c.verify(res) : null;
            if (!c.verify) await res.body?.cancel().catch(() => undefined);
            return problem
              ? { status: "unhealthy", detail: `${c.label}: ${problem}` }
              : { status: "healthy", detail: `${c.label}: ok` };
          }
          let body = "";
          try {
            body = (await res.text()).slice(0, 2000);
          } catch {
            // Unreadable: classified by status alone.
          }
          const reason = c.classify
            ? c.classify(res.status, body)
            : classifyHttpFailure(res.status, { notFound: c.notFound, body });
          return {
            status: statusForReason(reason),
            detail: `${c.label}: ${reason} (HTTP ${res.status})`,
          };
        } catch (err) {
          return {
            status: "unhealthy",
            detail: `${c.label}: no answer (${err instanceof Error ? err.name : "error"})`,
          };
        }
      })
    );
    const status = outcomes.reduce<HealthStatus>(
      (worst, o) => (RANK[o.status] > RANK[worst] ? o.status : worst),
      "healthy"
    );
    return {
      name: this.name,
      status,
      latencyMs: now() - start,
      detail: outcomes.map((o) => o.detail).join("; "),
      checkedAt: at(),
    };
  }
}
