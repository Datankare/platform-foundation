# ADR-045: Governed Image Generation

Status: Proposed (Phase 5 Sprint 6 $\u2014 reserved at the entry gate; authored in full after the pre-code survey). Decision maker: Raman Sud.
Related: ADR-017 §8 (multimodal surface map), ADR-040 (held-action & dual-control admin), ADR-041 (escalation SLA), ADR-044 (multimodal provider interface), ADR-046 (multimodal content safety), ADR-047 (provenance & synthetic-media detection).

---

## Reserved scope (to be authored in full)

Image generation as a **committed external effect**, not a plain provider call $\u2014 because generation spends money and produces a durable artifact (P17: _"actions that spend money or modify state are durable, idempotent, and explicitly approved; draft actions are held until committed"_).

Lifecycle for every generation: **draft → screen (ADR-046) → classify risk → admin-policy route → commit.**

- **Risk classification.** Requester trust, input-screen verdict, output-screen verdict, target surface, and content category roll into a risk tier $\u2014 the same classifier the held-action path uses.
- **Admin-governed policy (P13).** A central, admin-tunable policy maps tier → commit path: low tier auto-commits at the boundary; high tier is **held for human Confirm** via the ADR-040 dual-control path. Category overrides (e.g. `avatar`→low, `ugc`→high) layer on top. **Screening is always-on and never a policy knob** $\u2014 the policy governs commit-gating, not whether to screen.
- **Committed at the boundary (P17).** Low-risk auto-commits _at_ the boundary (not bypassing it); nothing is surfaced, stored, or counted as spend until commit. Idempotent $\u2014 a retry never double-spends.
- **Provenance on commit (ADR-047).** A C2PA content credential + watermark is attached as part of commit; an image is not "real" until screened, credentialed, and committed.
- **Reuse, not reinvention.** The risk classifier + policy engine are the ADR-040/041 held-action / dual-control substrate applied to a new effect type.

L21: a generation-lifecycle conformance kit (draft-held, fail-closed, idempotent-commit).

Principles (L12): **P17 Core**; P10 / P13 / P6 / P3 support.
