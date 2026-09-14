# ADR-037 — Dynamic content generation framework

Status: Proposed (Phase 5 Sprint 4 — reserved; authored after the pre-code survey).
Spec basis: ADR-028 (application framework — D1 consumer-implements), ADR-015 (prompt
registry), ADR-021 (Guardian content-screening hook), ADR-031 (propose->commit boundary).

## Context

Reserved for the Sprint 4 content-generation framework: consumer-defined content types +
templates producing schema-conforming AI content, safety-screened before it surfaces and held
until committed. Number reserved per Gotcha 70; the decision body is authored after the
Curator / prompt-registry code survey (L11/L14), before any framework code.
