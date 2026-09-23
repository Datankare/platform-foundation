# ADR-046: Multimodal Content Safety

Status: Proposed (Phase 5 Sprint 6 $\u2014 reserved at the entry gate; authored in full after the pre-code survey). Decision maker: Raman Sud.
Related: ADR-005 / ADR-016 (content-safety architecture), ADR-021 (Guardian), ADR-043 (UGC input-surface screening $\u2014 the text-direction analogue), ADR-044 (multimodal input), ADR-045 (governed image generation), ADR-047 (provenance & synthetic-media detection). Governs: **Standing Rule 11** $\u2014 no surface, including a multimodal one, ships unscreened.

---

## Reserved scope (to be authored in full)

Always-on screening of image/audio **inputs** and generated **images**, defining the `screenModality` seam that ADR-044 (input) and ADR-045 (output) consume $\u2014 the multimodal analogue of the ADR-043 `screenContent` seam.

- **Two enforcement points, both fail-closed.** Inputs screened before they reach a model (pipeline defence); generated images screened before commit (output validation). Block / escalate / screen-error all withhold (P4).
- **Independent, separately tunable axes.** NSFW/harmful, real-person likeness/impersonation, and a baseline harmful-content classifier are distinct signals $\u2014 each independently configurable, each able to raise risk tier or force the governed path.
- **Two kinds of category rule.** _Commit-gating_ categories (avatar/icon → auto-commit-eligible) are admin-tunable; _prohibited / forced-escalate_ categories (e.g. NSFW policy) are admin-tunable in strictness but cannot be auto-committed away.
- **Hard-refuse invariants $\u2014 above the tier system, non-configurable.** CSAM and real-person sexual imagery are hard-refused $\u2014 never generated, never surfaced, reported per policy $\u2014 independent of any admin tier or category setting. No configuration path can enable them.
- **Provider-agnostic classifiers** plug in behind the seam (vision/audio classifiers differ from text).

L21: a provider-agnostic multimodal-screening conformance kit (both directions, fail-closed, hard-refuse invariants).

Principles (L12): **P4 Core**.
