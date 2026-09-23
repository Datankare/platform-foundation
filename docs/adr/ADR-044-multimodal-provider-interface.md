# ADR-044: Multimodal Provider Interface (Image + Audio Input)

Status: Proposed (Phase 5 Sprint 6 $\u2014 reserved at the entry gate; authored in full after the pre-code survey). Decision maker: Raman Sud.
Related: ADR-015 (GenAI-native stack), ADR-017 §8 (GenAI-native surface map $\u2014 multimodal), ADR-022 (agent runtime / provider orchestration), ADR-045 (governed image generation), ADR-046 (multimodal content safety), ADR-047 (provenance & synthetic-media detection). `platform/ai/provider.ts`.

---

## Reserved scope (to be authored in full)

Extend the AI provider interface to accept multimodal input $\u2014 image and audio content blocks $\u2014 alongside text.

- **Modality-typed content model (shared substrate).** One `MultimodalContent` shape (text | image | audio) with declared MIME/format, defined once and consumed by ADR-045/046/047 alike $\u2014 no per-ADR re-derivation.
- **Provider capability descriptor (shared substrate).** Each provider declares `{ inputs, outputs }` per modality; routing reads this single source of truth (P7).
- **Capability/cost-aware routing.** Selects a modality-capable provider by capability, cost, latency; behavioural variance across providers addressed explicitly.
- **Screened on entry.** Multimodal input is a new input surface $\u2014 routed through the ADR-046 `screenModality` seam before it reaches a model (Standing Rule 11).
- **Instrumented + cost-tracked.** Modality, model, tokens, latency, cost recorded per call (P3/P12); the ADR-047 synthetic-origin detection signal attached as a risk input.
- **Degrades to text-only** when no modality-capable provider is available (P11).
- Depends on **TASK-025** (ALB for a stable ffmpeg-service URL) if the audio path leans on ffmpeg-service for format conversion.

L21: a provider-agnostic multimodal-input conformance kit.

Principles (L12): **P7 Core**; P1 / P3 / P11 / P12 support.
