/**
 * platform/auth/pool-shape-probe.ts — readiness says when the identity pool lacks the shape the
 * platform requires (review 17 L2/L4)
 *
 * The platform's Cognito provider relies on two properties of the pool that no setting carries:
 *
 *   sign-in by email address   UsernameAttributes includes email, so a native user's pool
 *                              username is its sub — a refresh's SECRET_HASH is computed with the
 *                              sub, and the native-user rule (identityProvidersFrom) compares the
 *                              two. A pool that signs in by a chosen username cannot refresh a
 *                              session; the shape is fixed when the pool is created. Unhealthy:
 *                              the probe is registered required, so the instance is not ready —
 *                              the deployment is refused before it serves on the wrong pool.
 *   `identities` readable      the app client may read who verified an address (ReadAttributes
 *                              null — every attribute — or listing identities). Hidden, it is
 *                              absent for every user; the provider then takes no user as native
 *                              (fail closed) and the probe reports degraded.
 *
 * Checked with the administrative credentials (DescribeUserPool, DescribeUserPoolClient). Without
 * them the probe cannot ask: it answers healthy, and says once in the log which commands the
 * operator runs instead (POOL_SHAPE_OPERATOR_CHECK; docs/ENV_REFERENCE.md "Cognito pool shape").
 * A pool that does not answer is degraded, never unready, and is asked again after a minute. A
 * definite answer is kept for PROBE_CACHE_MS; each check is bounded well inside the readiness
 * per-probe timeout, so a slow pool never takes an instance out of rotation.
 *
 * @module platform/auth
 */

import { logger } from "@/lib/logger";
import type { HealthCheckResult, HealthProbe } from "@/platform/observability/types";
import type { PoolShapeReadiness } from "./provider";
import { initAuth } from "./auth-init";
import { getAuthProvider } from "./config";

/** How long a definite answer is kept (the shape changes rarely; one is fixed at creation). */
const PROBE_CACHE_MS = 10 * 60_000;
/** How long an unavailable answer is kept before asking again. */
const RETRY_MS = 60_000;
/** The bound of one check (inside the readiness per-probe timeout, 3 s). */
const CHECK_BUDGET_MS = 2_000;

export const POOL_SHAPE_PROBE = "identity-pool";

export interface PoolShapeProbeOptions {
  /** The check; default: the registered auth provider's checkPoolShape (none: not checked). */
  readonly check: () => Promise<PoolShapeReadiness | null>;
  readonly now?: () => number;
  readonly budgetMs?: number;
}

/** The probe's answer for a pool-shape result. */
export function poolShapeStatus(result: PoolShapeReadiness | null): {
  readonly status: HealthCheckResult["status"];
  readonly detail: string;
} {
  if (result === null)
    return { status: "healthy", detail: "the identity provider has no pool to check" };
  if (result.state === "ready")
    return {
      status: "healthy",
      detail: "the pool signs in by email address; identities is readable",
    };
  if (result.state === "unsafe")
    return {
      status: result.cause === "username_sign_in" ? "unhealthy" : "degraded",
      detail: result.reason,
    };
  return {
    status: result.cause === "no_credentials" ? "healthy" : "degraded",
    detail: result.reason,
  };
}

export function createPoolShapeProbe(options: PoolShapeProbeOptions): HealthProbe {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? CHECK_BUDGET_MS;
  let cached: { at: number; keepMs: number; result: HealthCheckResult } | null = null;
  let toldOperator = false;
  return {
    name: POOL_SHAPE_PROBE,
    async check(): Promise<HealthCheckResult> {
      const at = now();
      if (cached && at - cached.at < cached.keepMs) return cached.result;
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let shape: PoolShapeReadiness | null;
      try {
        shape = await Promise.race([
          options.check(),
          new Promise<PoolShapeReadiness>((resolve) => {
            timer = setTimeout(
              () =>
                resolve({
                  state: "unknown",
                  reason: `the pool did not answer within ${budgetMs} ms`,
                  cause: "unavailable",
                }),
              budgetMs
            );
          }),
        ]);
      } catch (err) {
        shape = {
          state: "unknown",
          reason: `the pool could not be checked (${err instanceof Error ? err.name : "error"})`,
          cause: "unavailable",
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (
        shape?.state === "unknown" &&
        shape.cause === "no_credentials" &&
        !toldOperator
      ) {
        toldOperator = true;
        logger.warn("Identity pool shape not checked: check it by hand", {
          route: "platform/auth/pool-shape-probe",
          detail: shape.reason,
        });
      }
      const { status, detail } = poolShapeStatus(shape);
      const result: HealthCheckResult = {
        name: POOL_SHAPE_PROBE,
        status,
        latencyMs: Date.now() - started,
        detail,
        checkedAt: new Date(at).toISOString(),
      };
      const transient = shape?.state === "unknown" && shape.cause === "unavailable";
      cached = { at, keepMs: transient ? RETRY_MS : PROBE_CACHE_MS, result };
      return result;
    },
  };
}

/** The probe over the registered auth provider (instrumentation.ts, AUTH_PROVIDER=cognito). */
export function createAuthPoolShapeProbe(): HealthProbe {
  return createPoolShapeProbe({
    check: async () => {
      initAuth();
      const provider = getAuthProvider();
      return provider.checkPoolShape ? provider.checkPoolShape() : null;
    },
  });
}
