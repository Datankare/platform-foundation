/**
 * platform/jobs/backoff.ts — when a failed job is tried again (ADR-056 D2)
 *
 * Exponential from the policy's base (base, 2·base, 4·base, …), capped at its maximum, with
 * "equal jitter": half the delay is fixed and half is random. The fixed half keeps a retry from
 * firing at once; the random half spreads the retries of many jobs that failed together (a
 * database blip) so they do not all return at the same moment.
 *
 * @module platform/jobs
 */

import { randomInt } from "node:crypto";
import type { BackoffPolicy } from "./types";

/** A uniform number in [0, 1) from the platform's CSPRNG (the platform uses no weak random source). */
export function uniformRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

/** One minute, doubling to at most an hour. */
export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMs: 60_000,
  maxMs: 60 * 60_000,
});

/** Validate a policy: a positive base no larger than its maximum, both at most a day. */
export function checkBackoff(policy: BackoffPolicy): BackoffPolicy {
  const { baseMs, maxMs } = policy;
  const day = 24 * 60 * 60_000;
  if (!Number.isInteger(baseMs) || baseMs < 1_000 || baseMs > day) {
    throw new RangeError("backoff.baseMs must be a whole number of ms, 1 s – 1 day");
  }
  if (!Number.isInteger(maxMs) || maxMs < baseMs || maxMs > day) {
    throw new RangeError("backoff.maxMs must be a whole number of ms, baseMs – 1 day");
  }
  return Object.freeze({ baseMs, maxMs });
}

/**
 * The delay before the attempt after `attempt` (1 = the first attempt failed). `random` returns
 * [0, 1); injectable so tests are deterministic.
 */
export function retryDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = uniformRandom
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive whole number");
  }
  // 2^(attempt-1), without overflowing for a large attempt: past 2^30 the cap applies anyway.
  const factor = 2 ** Math.min(attempt - 1, 30);
  const delay = Math.min(policy.maxMs, policy.baseMs * factor);
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1 - Number.EPSILON) : 0;
  const half = delay / 2;
  return Math.round(half + unit * half);
}
