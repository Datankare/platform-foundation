/**
 * prompts/evals/index.ts — the eval-suite registry (ADR-038).
 *
 * EVAL_SUITES is the set of prompts with an authored suite. PENDING_EVAL names registered
 * prompts that do not yet have one — every entry is a tracked, build-visible commitment, not a
 * silent skip: the meta-test fails if a registered prompt is neither covered nor pending, and
 * fails on any stale pending entry. PENDING_EVAL must shrink to [].
 */
import type { EvalSuite } from "./types";
import { SAFETY_CLASSIFY_EVAL } from "./safety/classify.eval";
import { GATEKEEPER_EVAL } from "./social/gatekeeper.eval";
import { ANALYST_EVAL } from "./social/analyst.eval";
import { CURATOR_EVAL } from "./social/curator.eval";
import { CLASSIFY_AUDIO_EVAL } from "./input/classify-audio.eval";

/** Erase a suite's output type for heterogeneous storage; parse+assert stay internally
 *  consistent, so the cast is safe. */
function defineSuite<O>(s: EvalSuite<O>): EvalSuite<unknown> {
  return s as EvalSuite<unknown>;
}

export const EVAL_SUITES: readonly EvalSuite<unknown>[] = [
  defineSuite(SAFETY_CLASSIFY_EVAL),
  defineSuite(GATEKEEPER_EVAL),
  defineSuite(ANALYST_EVAL),
  defineSuite(CURATOR_EVAL),
  defineSuite(CLASSIFY_AUDIO_EVAL),
];

export const PENDING_EVAL: readonly string[] = [
  "admin-command-bar",
  "config-manager",
  "resolve-intent",
  "concierge",
  "matchmaker",
];
