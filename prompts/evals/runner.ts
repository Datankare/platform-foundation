/**
 * prompts/evals/runner.ts — the deterministic eval lane (ADR-038 D2/D3).
 *
 * The gating lane: parse each recorded fixture through the prompt's own parser and assert. No
 * live model, no key, no network — it runs on every PR. Malformed fixtures exercise the
 * parser's real fail-closed path. The non-gating live lane (which calls the model, re-records
 * fixtures, and traces into observability) is driven separately by `npm run eval:live` and is
 * never part of this gate.
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
