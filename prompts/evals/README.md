# Prompt eval harness (ADR-038)

Two lanes over every registered prompt:

- **Deterministic (gating, CI):** parse a recorded fixture through the prompt's own
  `parse*Response` and assert. No live model/key/network. See `runner.ts` / the
  `__tests__/prompt-evals.test.ts` meta-test.
- **Live (non-gating):** `npm run eval:live` (`live.run.ts`, TASK-204) builds each suite's live
  cases with the prompt's own builder, calls the model through the orchestrator (traced and costed
  as production calls are), parses and asserts, and records the answers in `recordings/` — which
  the deterministic lane replays on every PR (`__tests__/prompt-evals-live.test.ts`). Without
  `ANTHROPIC_API_KEY` it says it skipped (a notice and a test named for it), never silently;
  `REQUIRE_EVAL_LIVE=true` makes that a failure (the weekly keyed workflow,
  `.github/workflows/eval-live.yml`). Never a CI hard gate.

## Adding a suite

1. Create `prompts/evals/<domain>/<name>.eval.ts` exporting an `EvalSuite<Output>`:
   - `prompt` (registry name), `source` (the prompt file), `parse` (its exported parser),
   - `coverage.enums` — each output string-union and **all** its members (the meta-test checks
     this equals the union in `source`, so it cannot fall behind the contract),
   - `cases` — one tagged, passing case per enum member, plus `failclosed:*`, `boundary:*`, and
     `adversarial:*` cases. Fixtures are raw model strings; assertions run on the parsed output.
   - `live` — the prompt's config and builder, and at least one `live:*` case: an input and an
     assertion about meaning a correct model gives every time, stronger than the parser's
     fail-closed default (a parse failure must not pass it).
2. A core prompt's suite: add it to `CORE_EVAL_SUITES` in `index.ts`. A module prompt's suite: add it
   to the module's definition (`evals`, e.g. `platform/social/module.ts`) — the suite must be for
   one of that module's prompts (ADR-054 D4). `listEvalSuites()` is both. Remove the prompt from
   `PENDING_EVAL`.

The meta-test fails the build if any registered prompt is neither covered nor pending, if
`PENDING_EVAL` has stale entries, if declared enums don't match the source, if an enum member
lacks a case, or if the fail-closed / boundary / adversarial classes are missing. Comprehensive
by construction.
