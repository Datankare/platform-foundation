/**
 * prompts/evals/runner.ts — the deterministic eval lane (ADR-038 D2/D3).
 *
 * The gating lane: parse each recorded fixture through the prompt's own parser and assert. No
 * live model, no key, no network — it runs on every PR. Malformed fixtures exercise the
 * parser's real fail-closed path. The non-gating live lane (which calls the model, re-records
 * fixtures, and traces into observability) is runLive below, driven by `npm run eval:live`
 * (prompts/evals/live.run.ts); it is never part of this gate.
 */
import type { EvalSuite } from "./types";

export interface CaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly error?: string;
}

export function runDeterministic<O>(suite: EvalSuite<O>): readonly CaseResult[] {
  return suite.cases.map((c) => {
    try {
      const out = suite.parse(c.fixture);
      return { id: c.id, passed: c.assert(out) };
    } catch (err) {
      return {
        id: c.id,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/** One live-lane case's result: the raw answer is kept so the run can be recorded and replayed. */
export interface LiveCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly raw: string;
  readonly error?: string;
}

/** The model call the live lane makes: the prompt's config and its one user message → raw text. */
export type LiveCall = (
  config: EvalSuite<unknown>["live"]["config"],
  userMessage: string
) => Promise<string>;

/**
 * The live lane (ADR-038 §1, TASK-204 N-43): each live case's input through the prompt's own
 * builder, sent by `call` (the orchestrator, as production sends it), parsed by the prompt's own
 * parser and asserted. A call that fails is a failed case with its error, never a pass.
 */
export async function runLive<O>(
  suite: EvalSuite<O, unknown>,
  call: LiveCall
): Promise<readonly LiveCaseResult[]> {
  const results: LiveCaseResult[] = [];
  for (const c of suite.live.cases) {
    let raw = "";
    try {
      raw = await call(suite.live.config, suite.live.build(c.input));
      results.push({ id: c.id, passed: c.assert(suite.parse(raw)), raw });
    } catch (err) {
      results.push({
        id: c.id,
        passed: false,
        raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
