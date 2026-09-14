# ADR-038 — Prompt evaluation harness

Status: Accepted (Phase 5 Sprint 4). Decision maker: Raman Sud.
Spec basis: ADR-017 §4 (AI evaluation framework), ADR-015 (prompt registry), ADR-014
(observability), ADR-016 (structured classifier output), ADR-021 (Guardian screening),
ADR-030 (AUX contracts). L21 (conformance-kit discipline), L12 (this sprint's pre-code gate).

## 1. The end state

Every registered prompt has a **golden eval dataset** that exhausts its output contract, a
**runner** that scores prompt output against that dataset, and a **CI regression gate** that
fails the build when a prompt or template change breaks the contract. Two lanes:

- **Deterministic lane (gating, runs in CI on every PR).** No live model, no key, no network.
  It exercises the _deterministic_ half of every prompt — the builder (does the prompt
  assemble the expected instruction + sanitized input?), the output parser + self-healing
  layer, and schema conformance — against **recorded golden fixtures** (captured model
  outputs, well-formed and malformed). This is the lane that catches the regressions that
  actually break consumers: a template edit that changes the parse contract, a schema drift, a
  fail-closed default that stops firing. Deterministic and free, so it gates every PR
  (including forks and Dependabot PRs, which receive no secrets — the exact constraint that
  bit the Sprint-3d E2E).
- **Live lane (non-gating, keyed, manual/periodic).** `npm run eval:live` calls the real model
  through the orchestrator, scores _answer quality_ against the same datasets, and re-records
  the golden fixtures. It traces every call into the observability fabric. It is never a CI
  hard gate (non-deterministic, costs money, needs a key); it is a quality dashboard and the
  source of truth for the fixtures the deterministic lane replays.

The harness is a platform abstraction (PF-first). Consumers inherit it and add datasets for
their own prompts; the same conformance meta-test governs theirs.

## 2. Decisions

**D1 — Dataset format and location.** One typed eval file per prompt, colocated with the
prompt tree: `prompts/evals/<domain>/<name>.eval.ts`. It exports a typed suite:

```ts
export const SAFETY_CLASSIFY_EVAL: EvalSuite<ClassifierOutput> = {
  prompt: "safety-classify",
  cases: [
    { id: "violence-high", input: {...}, fixture: "...recorded model output...",
      assert: (o) => o.categories.includes("violence") && o.severity === "high" },
    // ...
  ],
};
```

TypeScript, not JSON: the `assert` predicates are type-checked against the prompt's own output
interface, so an output-contract change that a dataset doesn't account for fails `tsc`, not
just the runner. A `fixture` is the recorded raw model string the deterministic lane parses;
`input` is what the live lane sends.

**D2 — Scoring is deterministic assertion over structured output, never LLM-graded, in the
gate.** A case passes iff the parsed output satisfies its `assert` predicate — schema
conformance plus specific field expectations (categories, severity, decision, status,
confidence bounds). No model judges another model's answer in CI. (Answer-quality grading, if
ever wanted, is a live-lane metric, never a gate.)

**D3 — Record-replay (D3a).** The gating lane replays recorded fixtures; the live lane records
them. Fixtures are committed alongside the dataset. A prompt/template edit is validated by
re-running the live lane to refresh fixtures **and** by the deterministic lane confirming the
parser + schema still hold — a diff in committed fixtures is a reviewable signal that model
behavior shifted.

**D4 — CI gate.** A jest suite (`__tests__/prompt-evals.test.ts`) runs the deterministic lane
for every registered prompt and fails on any failing case. It is part of the standard gate
(fmt / tsc / eslint / jest / coverage), so it blocks promotion like any other test.

**D5 — Comprehensive fixtures are MECHANICALLY ENFORCED, not aspirational.** This is the core
requirement. For each in-scope prompt, the conformance meta-test introspects the prompt's
output contract and **fails CI unless the dataset covers, at minimum:**

1. **Exhaustive enum coverage** — one passing case asserting _each member_ of _every_ string-
   union / enum field in the output type. safety-classify must have a case for each of the six
   `SafetyCategory` members and each of the four `SafetySeverity` members; gatekeeper for
   `approve` | `deny` | `review`; analyst for all four `HealthStatus`; classify-audio for
   `speech` | `music` | `noise`; curator/matchmaker for each `priority`. Any enum member with
   no asserting case fails the meta-test with the member named.
2. **Fail-closed / self-healing paths** — every documented default. A malformed-output fixture
   (truncated JSON, wrong shape, empty, non-JSON prose) that the parser must self-heal to the
   typed fail-closed default: safety → `unsafe` (fail-closed), concierge → default welcome
   actions (P11), gatekeeper → `review`, etc. The meta-test fails if a prompt declaring a
   fail-closed default has no malformed-output case exercising it.
3. **Boundary conditions** — empty input; oversized input (at/above `maxTokens`); confidence at
   `0`, `1`, and a mid value; empty arrays and max-size arrays for list outputs (matchmaker,
   curator); every optional field both present and absent.
4. **Adversarial inputs** — at least: a prompt-injection attempt ("ignore previous
   instructions…"), a unicode/emoji/RTL-override payload, and an over-length flood. These
   assert the prompt still yields a schema-valid, fail-closed-safe result — never that the
   injection succeeds.

The enum-coverage and fail-closed checks are derived by parsing the prompt's exported output
type (the same AST approach the agent-registry-integrity guard uses), so adding an enum member
without a fixture, or a prompt without its fail-closed case, is a red build — comprehensiveness
by construction. The boundary/adversarial classes are enforced by a required-tag manifest per
case (`tags: ["enum:violence", "boundary:empty", "adversarial:injection"]`) whose completeness
the meta-test checks against the taxonomy.

**D6 — Observability (live lane).** Every live eval call traces model / prompt-name /
prompt-version / tokens / latency / cost / trajectory into the ADR-014 fabric, keyed by case
id, so quality and cost trends per prompt version are inspectable.

**D7 — Registry completeness is a precondition and is enforced.** The harness scopes to the
_true_ prompt set, not just what `listPrompts()` currently returns. Today only `safety-classify`
and `admin-command-bar` are registered though ~10 prompt files exist. The meta-test therefore
also fails CI when a `prompts/**/*-v*.ts` prompt file is not registered in `PROMPT_REGISTRY`,
and when a registered prompt has no eval dataset. Closing that gap (registering the social /
input prompts) is the first implementation step of the harness work, so coverage is over every
prompt, not a subset.

## 3. How we get there — Sprint 4 sequencing

ADR-038 is built **first**, because ADR-036 (adaptive behavior) and ADR-037 (content
generation) both gate on it — neither ships a prompt without an eval. Order: (1) register the
unregistered prompts + backfill their eval datasets to the D5 taxonomy; (2) the runner + both
lanes; (3) the CI gate + conformance meta-test; (4) only then ADR-036/037, each of which adds
its prompts + datasets under the same enforced rules.

## 4. Background — how we got here

The AI evaluation framework was specified in Phase 3 (ADR-017 §4), deferred through Phase 4,
and never built. Prompts accumulated as versioned artifacts (ADR-015) with structured outputs
(ADR-016) and self-healing parsers, but nothing asserts they keep their contract across edits.
Sprint 4 introduces two _generative_ surfaces whose whole value is prompt-driven; shipping them
without a regression gate on prompt behavior would be shipping unguarded. Hence the harness is
the sprint's first deliverable, not an afterthought.

## 5. Invariants

- No prompt is registered without an eval dataset (D4/D7).
- No eval dataset is incomplete against the D5 taxonomy — enum-exhaustive, fail-closed,
  boundary, adversarial — enforced by the meta-test, not review.
- The gate never depends on a live model, a key, or the network (D1–D3): it runs on every PR.
- The live lane never gates CI; it records fixtures and reports quality/cost (D3/D6).
- Fixtures are committed; a fixture change is a reviewed signal of model drift (D3).
- Adversarial cases assert fail-closed-safe outcomes only — an eval never encodes a
  successful injection as "expected."

## 6. Conformance kit (L21)

`__tests__/prompt-evals.test.ts` is the meta-test. It fails CI when: a prompt file is
unregistered (D7); a registered prompt lacks a dataset (D4); a dataset omits any enum member,
fail-closed default, boundary class, or adversarial class required by the D5 taxonomy; or any
deterministic case fails. It is the prompt-layer analogue of
`agent-registry-integrity.test.ts` — the registry is the single source of truth for what
prompts exist, and every one must be exhaustively evaluated.

## 7. Related

ADR-017 §4 (origin spec), ADR-015 (prompt registry), ADR-014 (observability), ADR-016
(structured safety output), ADR-021 (Guardian screening — ADR-037 content routes through it),
ADR-030 (AUX). Consumed by ADR-036, ADR-037. Standing rules L12, L21.

_Last updated: September 14, 2026 (Phase 5 Sprint 4 — ADR-038 authored in full: deterministic
record-replay gate + non-gating live lane, with enum-exhaustive / fail-closed / boundary /
adversarial fixture coverage mechanically enforced by the conformance meta-test, and registry
completeness enforced as a precondition)._
