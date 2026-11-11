/**
 * platform/voice/acrcloud-usage.ts — ACRCloud's prepaid credit, watched (TASK-212, N-77)
 *
 * ACRCloud is prepaid: what ends song identification is the account's credit running out, and
 * until now the only sign was the exhaustion itself (status 3003, "Request count limit exceeded",
 * classified "quota" by acrcloud-identify.ts). ACRCloud offers no API that reports an account's
 * balance or remaining quota — its console API has projects, buckets and an undocumented daily
 * statistic, no balance — and its identification responses carry no quota header
 * (docs.acrcloud.com: "Identification API", "Console API → Base Projects", "Error Codes"). So
 * the platform counts what ACRCloud bills, as its documentation defines it — "Valid Requests =
 * Requests with results + Requests with no results / 2" (docs.acrcloud.com, FAQ "Definition of
 * Terms") — and compares the count with the operator's budget, ACRCLOUD_CREDIT_ALERT_AT (the
 * valid requests after which to top up):
 *
 *   recordAcrCloudRequest   after every answered identification (a result, or none), the count
 *                           is added in one statement (migration 069, provider_usage_add) — on
 *                           every instance, none lost. Crossing the budget raises the alert
 *                           `credentials.acrcloud_credit_low` once (log, metric, error report).
 *                           Never fails the identification it counts.
 *   createAcrCloudCreditProbe  readiness and /api/health ("song-id-credit", degraded-only): at or
 *                           over the budget, or with no budget set while ACRCloud serves, it is
 *                           degraded — the deployment still serves — and readiness reports the
 *                           change to the error reporter.
 *
 * After a top-up the operator raises ACRCLOUD_CREDIT_ALERT_AT by the valid requests the new
 * credit buys (docs/ROTATION_RUNBOOK.md): the count is never reset or edited by hand.
 *
 * Without a database (local runs, unit tests) the count is this process's own.
 *
 * @module platform/voice/song-id
 */

import { logger } from "@/lib/logger";
import { hasDatabase, withPlatformTx } from "@/platform/data";
import { getSingleton } from "@/platform/kernel/singleton";
import { raiseAlert } from "@/platform/observability/alert";
import { logCaught } from "@/platform/observability/caught-error";
import type { HealthCheckResult, HealthProbe } from "@/platform/observability/types";

/** The provider's row in provider_usage. */
export const ACRCLOUD_USAGE_PROVIDER = "acrcloud";
/** The readiness probe's name. */
export const ACRCLOUD_CREDIT_PROBE = "song-id-credit";
/** The alert raised when the count reaches the budget. */
export const ACRCLOUD_CREDIT_ALERT = "credentials.acrcloud_credit_low";

/** What ACRCloud answered: a result (billed one), or none (billed a half). */
export type AcrCloudOutcome = "result" | "no_result";

export interface AcrCloudUsage {
  /** Valid requests counted, as ACRCloud bills them (a half for each request with no result). */
  readonly validRequests: number;
  /** When counting began (ISO); null when nothing has been counted. */
  readonly since: string | null;
}

const MEMORY_KEY = "platform.voice.acrcloud-usage";
const memory = () =>
  getSingleton<{ halves: number; since: string | null }>(MEMORY_KEY, () => ({
    halves: 0,
    since: null,
  }));

/**
 * The budget in valid requests from ACRCLOUD_CREDIT_ALERT_AT as getAcrCloudConfig read it (the one
 * place ACRCLOUD_* is read, TASK-042), or undefined when unset or not a positive whole number.
 */
export function parseCreditAlertAt(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^[1-9]\d{0,8}$/.test(value)) return undefined;
  return Number(value);
}

async function addHalves(halves: number): Promise<number> {
  if (!hasDatabase()) {
    const m = memory();
    m.halves += halves;
    m.since ??= new Date().toISOString();
    return m.halves;
  }
  const { rows } = await withPlatformTx((tx) =>
    tx.query<{ total: string }>(
      "select public.provider_usage_add($1, $2)::text as total",
      [ACRCLOUD_USAGE_PROVIDER, halves]
    )
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Count one answered identification, and raise the alert when this one reached the budget. Never
 * throws: a count that cannot be written is logged (the identification stands).
 */
export async function recordAcrCloudRequest(
  outcome: AcrCloudOutcome,
  alertAt: number | undefined
): Promise<void> {
  const halves = outcome === "result" ? 2 : 1;
  let total: number;
  try {
    total = await addHalves(halves);
  } catch (err) {
    logCaught(logger, "ACRCloud usage could not be counted", err, {
      route: "platform/voice/acrcloud-usage",
    });
    return;
  }
  const at = alertAt;
  if (at === undefined) return;
  const limit = at * 2;
  if (total >= limit && total - halves < limit) {
    raiseAlert({
      name: ACRCLOUD_CREDIT_ALERT,
      message: `ACRCloud has billed ${total / 2} valid requests, reaching ACRCLOUD_CREDIT_ALERT_AT (${at}): top up the prepaid credit in the ACRCloud console, then raise ACRCLOUD_CREDIT_ALERT_AT by what the new credit buys (docs/ROTATION_RUNBOOK.md)`,
      tags: { provider: ACRCLOUD_USAGE_PROVIDER },
    });
  }
}

/** The count so far. Throws when the database cannot be read. */
export async function readAcrCloudUsage(): Promise<AcrCloudUsage> {
  if (!hasDatabase()) {
    const m = memory();
    return { validRequests: m.halves / 2, since: m.since };
  }
  const { rows } = await withPlatformTx((tx) =>
    tx.query<{ billable_halves: string; since: Date | string }>(
      "select billable_halves::text as billable_halves, since from public.provider_usage_read($1)",
      [ACRCLOUD_USAGE_PROVIDER]
    )
  );
  const row = rows[0];
  if (!row) return { validRequests: 0, since: null };
  return {
    validRequests: Number(row.billable_halves) / 2,
    since: new Date(row.since).toISOString(),
  };
}

/** The process's own count back to zero (tests only). */
export function resetAcrCloudUsageMemory(): void {
  const m = memory();
  m.halves = 0;
  m.since = null;
}

/**
 * Readiness (degraded-only): whether the ACRCloud credit is being watched and is not yet at its
 * budget. `serving` says whether ACRCloud serves this deployment (the live provider's name);
 * `alertAt` is the budget (parseCreditAlertAt).
 */
export function createAcrCloudCreditProbe(
  serving: () => boolean,
  alertAt: () => number | undefined
): HealthProbe {
  const result = (status: HealthCheckResult["status"], detail: string) => ({
    name: ACRCLOUD_CREDIT_PROBE,
    status,
    latencyMs: 0,
    detail,
    checkedAt: new Date().toISOString(),
  });
  return {
    name: ACRCLOUD_CREDIT_PROBE,
    async check(): Promise<HealthCheckResult> {
      if (!serving()) return result("healthy", "ACRCloud does not serve this deployment");
      const at = alertAt();
      if (at === undefined) {
        return result(
          "degraded",
          "ACRCLOUD_CREDIT_ALERT_AT is not set (a positive whole number of valid requests): the prepaid credit is not watched"
        );
      }
      let usage: AcrCloudUsage;
      try {
        usage = await readAcrCloudUsage();
      } catch (err) {
        // The error's text goes to the log, never into a probe's answer.
        logCaught(logger, "ACRCloud usage could not be read", err, {
          route: "platform/voice/acrcloud-usage",
        });
        return result("degraded", "ACRCloud usage could not be read (see the log)");
      }
      const since = usage.since ? ` since ${usage.since}` : "";
      return usage.validRequests >= at
        ? result(
            "degraded",
            `${usage.validRequests} valid requests${since}, at or over ACRCLOUD_CREDIT_ALERT_AT (${at}): top up the credit, then raise the budget`
          )
        : result("healthy", `${usage.validRequests} of ${at} valid requests${since}`);
    },
  };
}
