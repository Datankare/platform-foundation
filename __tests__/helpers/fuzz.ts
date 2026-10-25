/**
 * __tests__/helpers/fuzz.ts — how hard property tests search (Adversarial Validation)
 *
 * Property tests (fast-check) run a modest number of generated cases on every commit, and many
 * more in the scheduled fuzz job (.github/workflows/fuzz.yml sets FC_NUM_RUNS), with a fresh
 * seed each time; a failure prints the seed and path to replay it.
 */

import type { Parameters as FcParameters } from "fast-check";

const DEFAULT_RUNS = 200;

export function fuzzRuns(): number {
  const n = Number(process.env.FC_NUM_RUNS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RUNS;
}

/** fast-check parameters for every property test. */
export function fuzzParams<T>(): FcParameters<T> {
  return { numRuns: fuzzRuns() };
}

/**
 * fast-check parameters for one of `parts` tests that together run one property (review 14 M-1):
 * each runs its share of fuzzRuns(), so the parts reach the same depth as one test would — in the
 * fuzz job too — while no single test comes near its time bound.
 */
export function fuzzParamsPart<T>(parts: number): FcParameters<T> {
  if (!Number.isInteger(parts) || parts < 1)
    throw new RangeError("parts must be a positive integer");
  return { numRuns: Math.ceil(fuzzRuns() / parts) };
}
