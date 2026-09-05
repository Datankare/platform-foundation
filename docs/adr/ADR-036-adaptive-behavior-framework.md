# ADR-036 — Adaptive behavior framework

Status: Proposed (Phase 5 Sprint 4 — reserved; authored after the pre-code survey).
Spec basis: ADR-028 (application framework — D1 consumer-implements, D3 action pipeline),
ADR-029 (agentic workflow framework), ADR-031 (action identity & lifecycle), ADR-015 (LLM
orchestration — fallback / circuit breaker).

## Context

Reserved for the Sprint 4 adaptive-behavior framework: an LLM-driven, consumer-implemented
decision seam that returns a typed, schema-validated app decision, gated through the D3
pipeline, with a mandatory deterministic fallback. Adaptive memory is within-session only for
Sprint 4; cross-session learning is deferred. Number reserved per Gotcha 70; the decision body
is authored after the Concierge / runtime code survey (L11/L14), before any framework code.
