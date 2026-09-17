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
import { MATCHMAKER_EVAL } from "./social/matchmaker.eval";
import { CONCIERGE_EVAL } from "./social/concierge.eval";
import { RESOLVE_INTENT_EVAL } from "./input/resolve-intent.eval";
import { PACING_EVAL } from "./adaptive/pacing.eval";

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
  defineSuite(MATCHMAKER_EVAL),
  defineSuite(CONCIERGE_EVAL),
  defineSuite(RESOLVE_INTENT_EVAL),
  defineSuite(PACING_EVAL),
];

export const PENDING_EVAL: readonly string[] = [];

/** Registered prompts that are tool-use (they call tools rather than returning parseable
 *  structured text), so they have no parse*Response and cannot run through the deterministic
 *  lane. Their conformance is the tool-schema, tested by the admin AI suite. The meta-test
 *  verifies each is genuinely parserless, so this cannot hide a parseable prompt. */
export const TOOL_USE_EXEMPT: readonly string[] = ["config-manager", "admin-command-bar"];
