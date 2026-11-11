/**
 * platform/providers/readiness-probes.ts — the health probes readiness asks, for this
 * deployment's selections (ADR-056 D4, TASK-142; TASK-197)
 *
 * Built once at boot, after initProviders() (instrumentation.ts — the platform's and an app's
 * own), so each probe wraps the live provider:
 *
 *   required       the database (when there is one), the selected cache, and the Cognito pool's
 *                  shape: an instance without them cannot serve, so it is unready.
 *   degraded-only  realtime, the job schedules, every module's probes (song identification, the
 *                  Google key and voices), the AI provider with the deployed key and models, an
 *                  external rate-limit store and the CA bundles' expiry: their failure reports
 *                  "degraded" — still serving — so one provider's outage cannot take every
 *                  instance out of rotation, and readiness reports the failure to the error
 *                  reporter when it changes.
 *
 * TASK-197 (audit D-2): the AI provider, the Google key and the rate-limit store had no probe.
 * Every external selection is now covered (__tests__/helpers/dependency-coverage.ts, and each
 * module slot's `coverage`), and __tests__/dependency-probe-coverage.test.ts holds that each
 * probe a coverage names is built here for that selection.
 *
 * @module platform/providers
 */

import { PostgresHealthProbe } from "@/platform/observability/health";
import type { HealthProbe } from "@/platform/observability/types";
import { hasDatabase } from "@/platform/data";
import { createCacheReadinessProbe, getCache } from "@/platform/cache";
import { createRealtimeServiceProbe } from "@/platform/realtime/service-probe";
import { createScheduleFreshnessProbe } from "@/platform/jobs/schedule-probe";
import { createAuthPoolShapeProbe } from "@/platform/auth/pool-shape-probe";
import { createModuleHealthProbes } from "@/platform/modules/contributions";
import { createAIProviderReadinessProbe } from "@/platform/ai/readiness-probe";
import { createRateLimitStoreProbe } from "@/platform/rate-limit/store-probe";
import {
  checkCertificatesAtBoot,
  createCertificateExpiryProbe,
} from "@/platform/observability/certificate-expiry";
import {
  getAuthProviderSetting,
  getRateLimitStoreSetting,
  getSupabaseUrl,
} from "./environment-contract";

export interface ReadinessProbes {
  readonly required: HealthProbe[];
  readonly degradedOnly: HealthProbe[];
}

export function buildReadinessProbes(
  env: Readonly<Record<string, string | undefined>> = process.env
): ReadinessProbes {
  // TASK-197 (audit D-6): a CA bundle past or near its notAfter is alerted at boot, once.
  checkCertificatesAtBoot(env);
  const required: HealthProbe[] = [
    ...(hasDatabase() ? [new PostgresHealthProbe()] : []),
    createCacheReadinessProbe(getCache()),
    // Review 17 L2/L4: a Cognito pool without the required shape (sign-in by email address)
    // is refused at readiness; `identities` hidden from the app client only degrades.
    ...(getAuthProviderSetting(env) === "cognito" ? [createAuthPoolShapeProbe()] : []),
  ];
  const degradedOnly: HealthProbe[] = [
    createRealtimeServiceProbe(env.REALTIME_PROVIDER ?? "mock", getSupabaseUrl(env)),
    ...createModuleHealthProbes(),
    // ADR-056 D4/D6: a deployment whose ticks never arrive reports it (degraded), naming the
    // duties that have stopped.
    createScheduleFreshnessProbe(),
    // TASK-197: the AI provider with this deployment's key and models (cached: it is billed).
    ...((env.AI_PROVIDER ?? "anthropic") === "anthropic"
      ? [createAIProviderReadinessProbe(env)]
      : []),
    // TASK-197: an external rate-limit store (postgres is the database's probe).
    ...(getRateLimitStoreSetting(env) === "upstash" ? [createRateLimitStoreProbe()] : []),
    // TASK-197 (audit D-6): the CA bundles' expiry (degraded within 30 days, unhealthy expired).
    createCertificateExpiryProbe(env),
  ];
  return { required, degradedOnly };
}
