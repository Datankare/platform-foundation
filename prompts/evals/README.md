# Prompt eval harness (ADR-038)

Two lanes over every registered prompt:

- **Deterministic (gating, CI):** parse a recorded fixture through the prompt's own
  `parse*Response` and assert. No live model/key/network. See `runner.ts` / the
  `__tests__/prompt-evals.test.ts` meta-test.
- **Live (non-gating):** `npm run eval:live` builds the prompt, calls the model, re-records
  fixtures, and traces into observability. Never a CI hard gate.

## Adding a suite

1. Create `prompts/evals/<domain>/<name>.eval.ts` exporting an `EvalSuite<Output>`:
   - `prompt` (registry name), `source` (the prompt file), `parse` (its exported parser),
   - `coverage.enums` — each output string-union and **all** its members (the meta-test checks
     this equals the union in `source`, so it cannot fall behind the contract),
   - `cases` — one tagged, passing case per enum member, plus `failclosed:*`, `boundary:*`, and
     `adversarial:*` cases. Fixtures are raw model strings; assertions run on the parsed output.
2. Add it to `EVAL_SUITES` in `index.ts` and remove the prompt from `PENDING_EVAL`.

The meta-test fails the build if any registered prompt is neither covered nor pending, if
`PENDING_EVAL` has stale entries, if declared enums don't match the source, if an enum member
lacks a case, or if the fail-closed / boundary / adversarial classes are missing. Comprehensive
by construction.
