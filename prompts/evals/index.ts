/**
 * prompts/evals/index.ts — the eval-suite registry (ADR-038).
 *
 * listEvalSuites() is the set of prompts with an authored suite: the core's (CORE_EVAL_SUITES)
 * then each registered module's (a module's suites are declared in its definition — ADR-054 D4). PENDING_EVAL names registered
 * prompts that do not yet have one — every entry is a tracked, build-visible commitment, not a
 * silent skip: the meta-test fails if a registered prompt is neither covered nor pending, and
 * fails on any stale pending entry. PENDING_EVAL must shrink to [].
 */
import { composeValues } from "@/platform/modules/compose";
import { defineSuite, type EvalSuite } from "./types";
import { SAFETY_CLASSIFY_EVAL } from "./safety/classify.eval";
import { CLASSIFY_AUDIO_EVAL } from "./input/classify-audio.eval";
import { RESOLVE_INTENT_EVAL } from "./input/resolve-intent.eval";
import { PACING_EVAL } from "./adaptive/pacing.eval";

/** The core's suites, one per core prompt that has a parseable contract. */
export const CORE_EVAL_SUITES: readonly EvalSuite<unknown>[] = [
  defineSuite(SAFETY_CLASSIFY_EVAL),
  defineSuite(CLASSIFY_AUDIO_EVAL),
  defineSuite(RESOLVE_INTENT_EVAL),
  defineSuite(PACING_EVAL),
];

/** The core's suites then the registered modules', one suite per prompt (refused otherwise). */
export function listEvalSuites(): readonly EvalSuite<unknown>[] {
  return composeValues(
    "eval suite",
    CORE_EVAL_SUITES,
    (s) => s.prompt,
    (m) => m.evals
  );
}

export const PENDING_EVAL: readonly string[] = [];

/** Registered prompts that are tool-use (they call tools rather than returning parseable
 *  structured text), so they have no parse*Response and cannot run through the deterministic
 *  lane. Their conformance is the tool-schema, tested by the admin AI suite. The meta-test
 *  verifies each is genuinely parserless, so this cannot hide a parseable prompt. */
export const TOOL_USE_EXEMPT: readonly string[] = ["config-manager", "admin-command-bar"];

/** Registered prompts whose output is free text shown to the user (no structured contract), so
 *  they have no parse*Response either. Their conformance is output screening: the stream is
 *  released only after the moderation pipeline passes it (platform/ai/screened-stream.ts,
 *  __tests__/screened-stream.test.ts). The meta-test verifies each is genuinely parserless. */
export const FREE_TEXT_EXEMPT: readonly string[] = ["stream-assistant"];
