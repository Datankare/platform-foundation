# ADR-019: Voice Pipeline Architecture

**Status:** Accepted
**Date:** 2026-04-14
**Author:** Raman Sud

## Context

The platform needs an end-to-end voice processing pipeline: audio in → text out (STT), text in → translated text (translation), text in → audio out (TTS). These operations must chain together with full observability, safety screening, graceful partial failure handling, and agentic compliance (P15-P18).

Each step in the chain calls a different external API. A single user action (e.g., "speak in Hindi, get Spanish translation with audio") requires 3+ API calls. The pipeline is fundamentally an autonomous agent — it acts on behalf of a user, makes decisions at each step, and produces output.

## Decision

### Pipeline as Agent

The voice pipeline is an agentic orchestrator. Each step maps to an agentic intent:

| Step      | Intent       | Meaning                                      |
| --------- | ------------ | -------------------------------------------- |
| STT       | `inform`     | Reporting what was heard                     |
| Safety    | `checkpoint` | Validating before proceeding                 |
| Translate | `propose`    | Suggesting a translation (not yet committed) |
| TTS       | `commit`     | Producing the final audio artifact           |

### Agentic Context (P15)

Every pipeline request carries actor identity:

```typescript
interface PipelineRequest {
  actorType?: "user" | "agent" | "system";
  actorId?: string;
  onBehalfOf?: string; // agent acting for a user
  traceId?: string; // distributed trace context
}
```

### Durable Trajectories (P18)

Every pipeline execution creates a trajectory — a sequence of steps with a shared `trajectoryId`. Each step carries its `stepIndex` for ordering. The trajectory is durable: the step results array in `PipelineResult` is the trajectory record.

### Translation Cache (P16 — Cognitive Memory)

Before calling the translation API, the pipeline checks an optional cache. Same text + same target language = cache hit. This reduces cost and latency for repeated translations (common in voice apps).

```
Pipeline: "Hello" → es
  Cache check: miss → call Google → store "Hola"
Pipeline: "Hello" → es (again)
  Cache check: hit → return "Hola" (no API call)
```

Cache is injectable — consumers wire their AICache or InMemoryCache implementation.

### Metrics Emission (P2)

Every step emits a `PipelineMetricEvent` via the `onMetric` callback:

```typescript
interface PipelineMetricEvent {
  step: string; // "stt" | "safety" | "translate" | "tts"
  intent: PipelineIntent; // P17 intent
  latencyMs: number;
  success: boolean;
  cached: boolean; // P16 cache hit
  actorType: string; // P15 actor
  actorId: string;
  traceId: string; // P9 trace
  trajectoryId: string; // P18 trajectory
  stepIndex: number;
}
```

Consumers wire `onMetric` to their MetricsSink for dashboards and alerting.

### Partial Failure Model (P11)

| Failure Point   | What's Returned                                  |
| --------------- | ------------------------------------------------ |
| STT fails       | Nothing (no transcript to work with)             |
| Safety blocks   | Transcript only (blocked content not translated) |
| Translate fails | Transcript only (partial success)                |
| TTS fails       | Transcript + translation (no audio)              |

### Safety: Fail Closed (P3)

If the safety screen throws an error (not just returns `safe: false`), the pipeline blocks. A broken safety screen must not allow content through.

### Health Probes

Three probes for proactive monitoring:

- `checkTranslationHealth()` — translates a known phrase
- `checkTTSHealth()` — synthesizes a short phrase
- `checkSTTHealth()` — sends minimal audio (tests connectivity)

## Consequences

### Positive

- Pipeline is agentic from day one (P15-P18) — not retrofitted
- Single trajectoryId across all steps — full pipeline visibility
- Cache reduces cost for repeated translations
- Partial failure returns useful results
- Safety screen injectable — consumers wire their own
- Provider abstraction means pipeline works with mock, Google, or future providers
- Metric callback decouples pipeline from MetricsSink implementation

### Negative

- Pipeline adds ~5ms orchestration overhead
- Three sequential API calls = latency is sum of all steps
- Cache requires consumers to manage TTL and invalidation

### Risks

- Three external APIs = three points of failure
- Mitigation: health probes detect degradation; partial results keep UX functional

## References

- ADR-014 — Observability (per-step metrics, trace context)
- ADR-015 — GenAI-Native Stack (provider abstraction pattern)
- ADR-018 — Realtime Architecture (agentic message schema)
- GENAI_MANIFESTO.md — P15-P18 agentic principles
- PHASE3_PLAN.md — Sprint 3 deliverables
