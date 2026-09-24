# ADR-044: Multimodal Provider Interface (Image + Audio Input)

Status: Proposed (Phase 5 Sprint 6). Decision maker: Raman Sud.
Related: ADR-015 (GenAI-native stack), ADR-017 §8 (GenAI-native surface map $\u2014 multimodal), ADR-022 (agent runtime / provider orchestration), ADR-014 (observability), ADR-045 (governed image generation), ADR-046 (multimodal content safety), ADR-047 (provenance & synthetic-media detection). `platform/ai/types.ts`, `platform/ai/provider.ts`, `platform/ai/orchestrator.ts`.

---

## 1. The end state

The AI provider interface accepts **image and audio input** as first-class content, alongside text, without a second message type or a parallel pipeline. A caller attaches image/audio blocks to an `AIMessage`; the orchestrator routes the request to a provider that **declares** support for those modalities, screens the input before the model sees it, meters it per modality, and $\u2014 if no capable provider is available $\u2014 degrades to text rather than failing the turn.

This ADR owns the **shared multimodal substrate** the rest of Sprint 6 builds on: the content model (the block types) and the provider **capability descriptor**. ADR-045 (generation), ADR-046 (screening), and ADR-047 (provenance/detection) consume these; none re-derives them.

## 2. Decisions

**D1 $\u2014 Multimodal blocks extend the existing content model; there is no second message type.** `AIContentBlock` gains `AIImageBlock` and `AIAudioBlock` (`{ type: "image" | "audio", source: { mediaType, data } }` $\u2014 raw bytes plus a declared MIME type, provider-portable). `AIMessage.content` is already `string | AIContentBlock[]`, so multimodal input is an **additive union extension**. This one content model is the write-once substrate: generation output (ADR-045), screening (ADR-046), and provenance (ADR-047) all speak the same block types.

**D2 $\u2014 Providers declare capability; routing reads it as the single source of truth.** The `AIProvider` contract gains `capabilities: { inputs: Modality[]; outputs: Modality[] }` (`Modality = "text" | "image" | "audio"`). A provider states what it accepts and produces; nothing infers it. This descriptor is the second piece of shared substrate $\u2014 ADR-045 reads `outputs` for generation routing, and the orchestrator reads `inputs` for input routing.

**D3 $\u2014 Routing is modality-aware and degrades fail-closed to text.** The orchestrator resolves the model tier, then checks the request's modalities against the candidate provider's `inputs`. If no available provider covers the requested modalities, the request **degrades to text-only** (the non-text blocks are dropped with a recorded reason) rather than erroring $\u2014 uptime over intelligence (P11). Per-provider behavioural variance (format quirks, size limits) is handled in the adapter, not leaked to callers.

**D4 $\u2014 Multimodal input is screened on entry.** Image/audio blocks are routed through the ADR-046 `screenModality` seam **before** the provider call, exactly as text is screened under ADR-043 (Standing Rule 11 $\u2014 no input surface, multimodal included, reaches a model unscreened). This ADR owns the call site; ADR-046 owns the seam and the classifiers. Screening is unconditional; it is never a routing or policy option.

**D5 $\u2014 Multimodal calls are instrumented and metered per modality.** The existing instrumentation records model, tokens, latency, and cost; this extends it with **modality** and **per-modality token/cost** attribution (P3/P12), and attaches the ADR-047 synthetic-origin detection verdict as a risk signal on the call record. Every multimodal call appends to the durable, inspectable trajectory (P18).

**D6 $\u2014 The substrate is defined once, here, and consumed $\u2014 not reimplemented.** The content model (D1) and capability descriptor (D2) are the shared multimodal spine. ADR-045/046/047 import these types and the descriptor; a reviewer rejects any per-ADR redefinition of a block type, a modality enum, or a capability shape. This is the architectural counterpart to the 3-ADR split: distinct decisions, one implementation spine.

## 3. Alternatives considered

(a) **A separate `MultimodalMessage` type** $\u2014 rejected: it forks the content model, forcing every consumer (tools, screening, trajectory) to branch on message shape. The union extension keeps one model.

(b) **Provider-specific multimodal handling with no capability descriptor** $\u2014 rejected: routing then has no source of truth for "can this provider take an image," and the decision scatters into ad-hoc checks. The descriptor centralizes it (P7).

(c) **URL/reference-only image input** $\u2014 rejected for the interface contract: a URL is not portable across providers and couples the platform to a fetch/host step. Bytes + declared MIME is provider-agnostic; a URL-resolving convenience can sit above the interface later.

(d) **Erroring instead of degrading when a modality is unsupported** $\u2014 rejected: it makes a provider outage or a capability gap a turn failure. Fail-closed here means _degrade to text with a recorded reason_ (P11), not deny.

## 4. Conformance (L21) $\u2014 provider-agnostic

A multimodal-input kit any provider adapter runs, asserting the contract rather than a vendor:

- an image-capable provider **round-trips** an image block (accepted, sent, response returned);
- a **text-only** provider handed an image block **degrades to text** with a recorded reason $\u2014 never errors, never silently sends unsupported content;
- the `screenModality` seam is **invoked on every** image/audio input before the provider call (screening cannot be bypassed);
- an **unknown / undeclared** modality **fails closed** (rejected, not passed through);
- per-modality cost + the detection signal are **recorded** on the call.

## 5. GenAI / RAMPS / WCAG

- **P7 Provider-Aware Orchestration (Core):** per-modality capability declaration + capability/cost routing + managed variance is the tenet realized for multimodal.
- **Support:** P1 (image/audio as first-class structured input), P3 (per-modality instrumentation), P4 (screened on entry, via ADR-046), P11 (degrade to text), P12 (per-modality cost), P18 (trajectory record).
- **RAMPS:** the new input surface is screened (safety), instrumented (observability), and capability-governed (control plane) day one.
- **WCAG:** image/audio inputs carry declared type + are accompanied by text alternatives in the consumer UI; the reference contract preserves alt-text metadata rather than discarding it. (Consumer-side rendering obligation; PF ships the contract.)

## 6. Consequences

- ADR-045 (generation), ADR-046 (screening), and ADR-047 (provenance/detection) build directly on D1's content model and D2's descriptor $\u2014 the reason this ADR lands first in the sprint.
- The audio path depends on **TASK-025** (a stable ffmpeg-service URL via ALB) **if** format conversion is required before a provider call; the interface itself is transport-agnostic.
- Deferred: image/audio **output** streaming semantics (generation commits via ADR-045, not streamed here); URL-resolved inputs; video. None changes the block model $\u2014 they extend it the same additive way.
