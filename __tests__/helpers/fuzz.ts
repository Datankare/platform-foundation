/**
 * __tests__/helpers/fuzz.ts — how hard property tests search (Adversarial Validation)
 *
 * Property tests (fast-check) run a modest number of generated cases on every commit, and many
 * more in the scheduled fuzz job (.github/workflows/fuzz.yml sets FC_NUM_RUNS), with a fresh
 * seed each time; a failure prints the seed and path to replay it.
 *
 * In CI the seed is fixed per commit (TASK-198, D-16): ci.yml sets FC_SEED from the commit SHA,
 * prints it in the step summary and uploads the jest results on failure, so a counterexample that
 * shows up in one pass (TASK-191: its log was gone) is replayed by
 * `FC_SEED=<seed> npx jest <file>` — the same cases, in every pass of that commit. Without FC_SEED
 * (locally, and in the fuzz job) each run draws a fresh one.
 *
 * Round 1 (TASK-198): each test file adds its own offset (a hash of its path from the repository
 * root) to FC_SEED, so the files of one pass do not all draw from one stream, and each CI pass
 * adds its own (ci.yml: coverage +0, core +1, time zone +2), so the three passes search different
 * cases. The replay command is unchanged: `FC_SEED=<the pass's seed> npx jest <file>` derives the
 * same file offset again.
 */

import { relative, sep } from "path";
import type { Parameters as FcParameters } from "fast-check";

const DEFAULT_RUNS = 200;

export function fuzzRuns(): number {
  const n = Number(process.env.FC_NUM_RUNS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RUNS;
}

/**
 * The fixed seed FC_SEED gives (a 32-bit integer), or undefined for a fresh one. A value that is
 * not an integer is an error: a typo must not silently fall back to a random seed.
 */
export function fuzzSeed(): number | undefined {
  const raw = process.env.FC_SEED?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`FC_SEED must be an integer, not "${raw}"`);
  return ((n | 0) + seedOffsetFor(currentTestFile())) | 0;
}

/** A file's offset to the seed: FNV-1a of its path from the repository root (0 for none). */
export function seedOffsetFor(file: string | undefined): number {
  if (!file) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < file.length; i++) {
    h ^= file.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** The running test file's path from the repository root, as jest reports it (or undefined). */
export function currentTestFile(): string | undefined {
  const state = (
    globalThis as { expect?: { getState?: () => { testPath?: string } } }
  ).expect?.getState?.();
  const path = state?.testPath;
  return path ? relative(process.cwd(), path).split(sep).join("/") : undefined;
}

/** fast-check parameters for every property test. */
export function fuzzParams<T>(): FcParameters<T> {
  const seed = fuzzSeed();
  return { numRuns: fuzzRuns(), ...(seed === undefined ? {} : { seed }) };
}

/**
 * fast-check parameters for test `part` (1…parts) of `parts` tests that together run one property
 * (review 14 M-1):
 * each runs its share of fuzzRuns(), so the parts reach the same depth as one test would — in the
 * fuzz job too — while no single test comes near its time bound.
 */
export function fuzzParamsPart<T>(parts: number, part: number): FcParameters<T> {
  if (!Number.isInteger(parts) || parts < 1)
    throw new RangeError("parts must be a positive integer");
  if (!Number.isInteger(part) || part < 1 || part > parts)
    throw new RangeError("part must be an integer from 1 to parts");
  // Each part its own seed under a fixed one: parts sharing a seed would draw the same cases.
  const seed = fuzzSeed();
  return {
    numRuns: Math.ceil(fuzzRuns() / parts),
    ...(seed === undefined ? {} : { seed: (seed + part - 1) | 0 }),
  };
}
