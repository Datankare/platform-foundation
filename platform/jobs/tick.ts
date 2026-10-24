/**
 * platform/jobs/tick.ts — what one tick may do, and the kinds that could never fit in one
 * (ADR-056 D2)
 *
 * Every host runs jobs through the same tick route (/api/internal/jobs/tick: Vercel Cron, or the
 * CLI worker on a container host), and each tick runs for TICK_BUDGET_MS. The runner claims a
 * job only when its kind's attempt timeout fits in what is left of that budget, so a kind whose
 * timeout is longer than TICK_BUDGET_MS − SETTLE_MARGIN_MS would be enqueued and never claimed:
 * its jobs would wait for ever. Boot refuses such a kind (checkJobsFitTick), naming it, in every
 * deployment — on Vercel the tick cannot run longer (the function's maxDuration), and the
 * container's worker calls the same route with the same budget.
 *
 * @module platform/jobs
 */

import {
  allowsHarnessSwitches,
  isProductionContext,
  type EnvSource,
} from "@/platform/providers/environment-contract";
import type { ResolvedJobDefinition } from "./types";

/** How long one tick runs jobs: the tick function's limit (maxDuration 60 s) less time to answer. */
export const TICK_BUDGET_MS = 45_000;
/** Kept free at the end of a budget for the last settle. */
export const SETTLE_MARGIN_MS = 2_000;
/** The longest attempt a tick can claim. */
export const TICK_MAX_TIMEOUT_MS = TICK_BUDGET_MS - SETTLE_MARGIN_MS;

/** Every kind whose attempt could never be claimed by a tick, as messages naming it. */
export function jobsThatDoNotFitTick(
  defs: readonly ResolvedJobDefinition[],
  env: EnvSource = process.env
): string[] {
  const host = env.DEPLOYMENT_HOST?.trim() || "this host";
  return defs
    .filter((d) => d.timeoutMs > TICK_MAX_TIMEOUT_MS)
    .map(
      (d) =>
        `Job "${d.kind}": timeoutMs ${d.timeoutMs} is longer than a tick can run an attempt ` +
        `(${TICK_MAX_TIMEOUT_MS} ms on ${host}: the tick's ${TICK_BUDGET_MS} ms budget less ` +
        `${SETTLE_MARGIN_MS} ms to settle) — its jobs would never be claimed. Lower its timeout ` +
        `and continue the work in a next part (continueWith) (ADR-056)`
    );
}

/** A kind no tick can run. */
export class JobTickFitError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "JobTickFitError";
  }
}

/**
 * Boot's check: in a deployment (production, not a local or CI run), refuse a kind no tick can
 * claim. Elsewhere (tests, local work) nothing is refused.
 */
export function checkJobsFitTick(
  defs: readonly ResolvedJobDefinition[],
  env: EnvSource = process.env
): void {
  if (!isProductionContext(env) || allowsHarnessSwitches(env)) return;
  const problems = jobsThatDoNotFitTick(defs, env);
  if (problems.length > 0) throw new JobTickFitError(problems);
}
