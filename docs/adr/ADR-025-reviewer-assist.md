# ADR-025: Advisory AI Reviewer-Assist

**Status:** Accepted
**Date:** 2026-05-31
**Phase / Sprint:** Phase 4 — Sprint 6 (Human Review + Appeals)
**Related:** ADR-016 (Content Safety Architecture), ADR-024 (Human Review + Appeals), GENAI_MANIFESTO P6/P10/P11/P12

## Context

Sprint 6 introduced the human-review queue (ADR-024): escalated moderation
decisions, Sentinel ban reviews, and user appeals land in a queue where a human
moderator claims an item and resolves it (uphold / overturn / modify). Each item
already carries the agent's full decision context — classifier output, severity,
the layer that triggered it, context factors, reasoning, and (when present) the
RAG explanation chain.

Moderators reviewing many items benefit from a starting point: a second opinion
that reads the same context and suggests a disposition. The risk is that such a
suggestion quietly becomes the decision — the human rubber-stamps the model and
the "human in the loop" becomes ceremonial. Any assist must therefore be
strictly advisory, and its absence (model down, ambiguous output) must never
block or degrade the human workflow.

## Decision

Add an **advisory** reviewer-assist that, on demand, produces a non-binding
recommendation for a single review item.

1. **Advisory only (P10).** The service returns `{ recommendation, rationale }`
   where `recommendation ∈ {uphold, overturn, modify}`. It never resolves an
   item, never changes account status, and never writes to the queue. The human
   makes and records the decision; the suggestion may prefill the decision
   control but is freely overridden.

2. **On-demand, not automatic (P12).** The recommendation is generated only when
   a reviewer requests it (a button → `POST /api/moderation/review/{id}/assist`),
   not for every queued item. This bounds token spend and latency to the cases a
   human actually wants help with.

3. **Fail-open (P11).** Any model error, timeout, or unparseable output yields
   `null`. The UI shows a quiet "no suggestion available" state (gray, not an
   error) and the reviewer proceeds unaided. A missing suggestion is never a
   failure state.

4. **Structured, validated output (P6).** The model is constrained to a small
   JSON object and the service validates it (decision ∈ the allowed set,
   rationale non-empty) before returning; markdown fences are stripped. Anything
   off-spec is treated as no suggestion.

5. **RBAC.** The route is gated on `can_moderate` like the other review routes
   (F6); the item is read server-side by id, so no client-supplied content is
   trusted into the prompt path.

The prompt is currently inline in `platform/moderation/review-assist.ts` at the
`standard` tier. If it grows (few-shot examples, tier tuning, per-source
variants) it should graduate into the `prompts/` registry like the other agents.

## Consequences

**Positive**

- Faster, more consistent reviews without weakening human authority.
- No new failure mode: assist outages are invisible to the workflow.
- Cost scales with actual reviewer demand, not queue volume.
- The suggestion reasons over the same recorded context the human sees, so it is
  auditable and explainable.

**Negative / risks**

- Automation bias: a confident-sounding rationale may nudge reviewers toward the
  suggestion. Mitigations: the banner is explicitly labelled advisory, the
  decision is never pre-submitted (only prefilled), and reviewer notes remain
  mandatory so every resolution carries a human rationale.
- A second model call per assisted review (bounded by on-demand use).

**Neutral**

- Recommendations are not persisted in this iteration. If we later want to
  measure assist accuracy (agreement vs. final human decision), we would log the
  suggestion alongside the resolution — deferred until there is demand.

## Alternatives considered

- **Auto-suggest on every item.** Rejected: unnecessary cost/latency and
  stronger automation-bias pull for items a human may resolve at a glance.
- **Auto-resolve high-confidence items.** Rejected outright: collapses the
  human-oversight guarantee that ADR-024 exists to provide.
- **Fail-closed (block review until assist returns).** Rejected: makes the
  moderation workflow depend on model availability, the opposite of the
  fail-open posture the rest of the safety stack uses.
