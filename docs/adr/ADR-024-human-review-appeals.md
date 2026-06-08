# ADR-024: Human Review Queue and Appeals System

**Status:** Accepted
**Date:** 2026-05-30
**Sprint:** Phase 4, Sprint 6

## Context

The moderation pipeline (Guardian + Sentinel) makes automated decisions about content
safety. Two scenarios require human judgment:

1. **Low-confidence classifications** — Guardian returns action: "escalate" when
   classifier confidence is below the threshold for the user's content rating level.
   The content is held, not blocked — a human reviewer decides.

2. **Account consequences** — Sentinel applies permanent bans that require human
   review to lift (ADR-016). Users can appeal block and ban decisions within a
   configurable window.

Without human review, there is no appeal path, no way to correct false positives,
and no mechanism for reversing automated bans. ADR-016 identified this as a gap
at Phase 2; Sprint 6 closes it.

## Decision

### Architecture

The review system connects three existing pipelines into a unified human review workflow:

- Guardian escalate (low confidence) enters the review queue automatically
- Sentinel ban (permanent) enters the review queue automatically
- User appeal (block or ban) enters the review queue via the appeal form

All three sources produce ReviewQueueItem records with the same lifecycle:
pending, claimed, resolved.

### Review queue item lifecycle

Items enter as "pending" from any of the three sources. A reviewer claims an item
(status: "claimed"), reviews the original decision with full context (reasoning chain,
explanation chain, user history), and resolves it with one of three decisions:

- **uphold** — original automated decision stands, no changes
- **overturn** — reverse the decision, restore account status, expire related strike
- **modify** — change severity or action, partial strike adjustment

Claimed items that exceed a configurable timeout are released back to "pending".

### Review queue item types

| Source     | Created by        | Trigger                        | Priority |
| ---------- | ----------------- | ------------------------------ | -------- |
| escalation | Middleware (auto) | Guardian action === "escalate" | high     |
| ban_review | Sentinel (auto)   | Sentinel consequence === "ban" | critical |
| appeal     | User (manual)     | User submits appeal form       | normal   |

### Appeal eligibility rules

- Only block or ban decisions can be appealed
- One appeal per original moderation decision
- Appeals must be submitted within configurable window (platform_config)
- Appeal must include a reason (minimum length enforced)
- Cannot submit appeal while another appeal for the same decision is pending

### Resolution side effects

| Decision | Side effects                                                       |
| -------- | ------------------------------------------------------------------ |
| uphold   | Original decision stands; no changes                               |
| overturn | Restore account status; expire related strike; update audit record |
| modify   | Change severity or action; partial strike adjustment               |

### Provider model

ReviewQueueStore follows the established provider pattern (P7):

- Interface in review-types.ts
- InMemoryReviewQueueStore for tests and development (default singleton)
- SupabaseReviewQueueStore for production (reference implementation)
- Singleton get/set/reset pattern for swapping
- Any consumer can implement the interface against any backend

### Integration points

| Existing module   | Integration                                        | Direction                  |
| ----------------- | -------------------------------------------------- | -------------------------- |
| middleware.ts     | Auto-submit on Guardian escalate                   | middleware -> review queue |
| sentinel.ts       | Auto-submit on ban consequence                     | sentinel -> review queue   |
| types.ts          | reviewerId + appealStatus on ModerationAuditRecord | review -> audit            |
| explainability.ts | ExplanationChain attached to review items          | RAG -> review              |
| platform_config   | Appeal window, claim timeout, min reason length    | config -> review           |

### Configuration (platform_config seeds)

| Key                                   | Default | Description                                |
| ------------------------------------- | ------- | ------------------------------------------ |
| moderation.appeal_window_hours        | 72      | Hours after decision to allow appeals      |
| moderation.review_claim_timeout_hours | 24      | Hours before unclaimed items are re-queued |
| moderation.appeal_reason_min_length   | 20      | Minimum characters for appeal reason       |

## Consequences

- Every automated moderation decision has a human-reviewable path
- False positives can be corrected without engineering intervention
- Permanent bans require human confirmation (ADR-016 requirement)
- Audit trail gains reviewerId and appealStatus fields
- Sentinel Gotcha #2 fulfilled: human review can downgrade account status
- Review queue adds operational overhead (staff time for reviews)

## GenAI Principles

P1 (intent-driven), P2 (bounded workflow), P3 (observable), P4 (safe),
P6 (structured outputs), P7 (provider-aware), P10 (human oversight — primary),
P11 (resilient), P12 (economic), P13 (control plane), P15 (identity),
P17 (cognition-commitment), P18 (durable trajectories).

---

_Last updated: May 30, 2026 (Sprint 6)_
