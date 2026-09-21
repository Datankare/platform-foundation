# ADR-043: User-Generated-Content Input-Surface Screening

Status: Proposed (Phase 5 Sprint 5). Decision maker: Raman Sud.
Related: ADR-016 / ADR-017 (content-safety architecture, moderation pipeline), ADR-021 (Guardian),
ADR-039 (Guardian on the runtime — fail-closed to `escalate`), ADR-041 (escalation SLA),
`platform/moderation/middleware.ts`. Governs: **Standing Rule 11** (no input surface ships
unscreened).

---

## 1. The end state

Every **user-generated input** that reaches a model — the input surface opened by
application-specific RAG (ADR-042) and by consumer-supplied prompts — passes through the Guardian
**before** it is embedded, retrieved against, or sent to a model, exactly as generated output is
screened before it surfaces (Sprint 4, ADR-037 D4). Standing Rule 11 says no input surface ships
unscreened; Sprint 5 makes that structural for the input direction — screening is on the path, not
the caller's responsibility, and fails closed.

## 2. Decisions

_To be authored during Sprint 5, after the pre-code survey of `platform/moderation/middleware.ts`
and its existing `screenContent(..., { direction })` seam (L11/L14)._ Open questions: the
`direction: "input"` screening contract and where it sits relative to RAG ingestion vs query time;
block / escalate handling for input (reject the turn vs substitute vs route to review, ADR-024 /
ADR-041); whether input is screened at ingest, at query, or both; and the L21 conformance kit
(blocked input is never embedded or retrieved; fail-closed on a screener error).

## 3. Consequences

_To follow with the decisions._
