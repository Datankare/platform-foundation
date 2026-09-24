# ADR-046: Multimodal Content Safety

Status: Accepted (Phase 5 Sprint 6). Decision maker: Raman Sud.
Related: ADR-005 / ADR-016 (content-safety architecture), ADR-021 (Guardian), ADR-039 (Guardian on the runtime $\u2014 fail-closed to `escalate`), ADR-043 (UGC input-surface screening $\u2014 the text-direction analogue), ADR-024 (human review queue), ADR-044 (multimodal input), ADR-045 (governed image generation), ADR-047 (provenance & synthetic-media detection). `platform/moderation/middleware.ts`, `platform/moderation/guardian.ts`. Governs: **Standing Rule 11** $\u2014 no surface, multimodal included, ships unscreened.

---

## 1. The end state

Image and audio $\u2014 arriving as input (ADR-044) or produced by generation (ADR-045) $\u2014 are screened by one seam, `screenModality`, the multimodal analogue of ADR-043's `screenContent`. It runs in both directions, fails closed, and evaluates **independent, separately-tunable safety axes**. Above every tunable knob sit **hard-refuse invariants** that no configuration can switch off.

## 2. Decisions

**D1 $\u2014 One seam, both directions, fail-closed.** `screenModality(content, { direction })` generalizes ADR-043's `screenContent` to image/audio. ADR-044 calls it on input **before** the model; ADR-045 calls it on a generated **draft before commit**. A `block` / `escalate` verdict, or a screener error, **withholds** (fail-closed to `escalate`, per ADR-039); `allow` / `warn` proceed. Screening is unconditional $\u2014 never a routing or policy option.

**D2 $\u2014 Independent, separately-tunable axes.** Three distinct signals, each its own classifier and verdict, each independently configurable: **NSFW / harmful imagery**, **real-person likeness / impersonation**, and a **baseline harmful-content** classifier. Any axis can raise the ADR-045 risk tier or force the governed path on its own; they do not collapse into one score.

**D3 $\u2014 Two kinds of category rule.** _Commit-gating_ categories (avatar/icon → auto-commit-eligible) are admin-tunable. _Prohibited / forced-escalate_ categories (e.g. the NSFW policy) are admin-tunable in **strictness** but can never be auto-committed away. This is the safety-side contract ADR-045's policy engine reads.

**D4 $\u2014 Hard-refuse invariants $\u2014 above the tier system, non-configurable.** **CSAM** and **real-person sexual imagery** are hard-refused: never generated, never surfaced, reported per policy $\u2014 independent of any tier, category, or admin setting. No configuration path enables them, and no risk-tier "low" can reach them. They are checked first, before any tunable axis.

**D5 $\u2014 Provider-agnostic classifiers behind the seam.** Vision and audio classifiers differ from text and from each other; they plug in behind `screenModality` as adapters (Guardian for text remains; image/audio classifiers are injected). The seam is the contract the L21 kit tests; the classifier is swappable.

**D6 $\u2014 Reuse the moderation spine.** Verdict shape (`allow / warn / block / escalate`), the fail-closed-to-`escalate` rule, the Sentinel/review-queue routing (ADR-024/039/041) are the existing moderation pipeline; this ADR adds modality adapters and the axis/invariant structure, not a second moderation system.

## 3. Alternatives considered

(a) **One blended safety score** $\u2014 rejected: it hides which axis fired and prevents independent tuning (an operator can't tighten real-person handling without moving NSFW). Independent axes are the requirement.

(b) **NSFW as a hard block only** $\u2014 rejected as the sole model: NSFW policy legitimately varies by deployment, so it is a tunable *prohibited/escalate* category $\u2014 but CSAM and real-person sexual imagery are **not** NSFW-policy, they are hard-refuse invariants above it. The two must not be conflated.

(c) **Screening as an admin on/off per surface** $\u2014 rejected: violates Rule 11 / P4. Only commit-gating and axis strictness are tunable; the presence of screening is invariant.

(d) **A separate multimodal moderation pipeline** $\u2014 rejected: duplicates ADR-016/021/039. One pipeline, modality adapters.

## 4. Conformance (L21) $\u2014 provider-agnostic

A multimodal-screening kit any classifier runs:

- **both directions** screen $\u2014 an unscreened input or an unscreened generated draft is a failure;
- `block` / `escalate` / classifier-error all **withhold** (fail-closed);
- each **axis fires independently** $\u2014 a real-person hit escalates even when NSFW is clean, and vice versa;
- a **prohibited category** cannot be auto-committed at any tier;
- the **hard-refuse invariants** refuse **regardless of configuration** $\u2014 the kit asserts no policy setting can enable them;
- `allow` / `warn` proceed.

## 5. GenAI / RAMPS / WCAG

- **P4 Structural Safety by Default (Core):** _"input validation baked into the pipeline; output validation mandatory before execution"_ $\u2014 both realized, fail-closed, with invariants beyond operator reach.
- **Support:** P10 (escalations route to the ADR-024 review queue), P13 (axis policy centrally governed), P3 (verdicts recorded).
- **RAMPS:** the new multimodal surface is structurally safe day one; hard-refuse invariants are a compliance guarantee, not a setting.
- **WCAG:** screening preserves the alt-text/description contract rather than stripping it.

## 6. Consequences

- ADR-044 and ADR-045 depend on this seam; it is authored alongside them and lands before their code.
- The admin gains axis-strictness + category controls; the hard-refuse invariants are shown as fixed, non-editable.
- Deferred: per-axis classifier tuning UIs and audio-specific harm categories beyond the baseline $\u2014 additive behind the same seam.
