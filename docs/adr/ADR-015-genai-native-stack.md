# ADR-015: GenAI-Native Stack Architecture

## Status: Accepted

## Date: 2026-04-03

## Context

Playform's core differentiator is GenAI as infrastructure fabric — not a feature bolted on, but the primary interaction model. During the Phase 1 review, an honest audit revealed that the admin UI command bar is the only place where this philosophy is fully delivered. Everywhere else, GenAI is either absent or a single raw API call with no sophistication.

Current state: raw `fetch()` to Anthropic API in two places (admin AI route, safety.ts). Inline prompt strings. No model tiering, no fallback, no caching, no token tracking. `prompts/README.md` is an empty placeholder.

## Decision

### GenAI-Native Stack Components

| Component                 | Purpose                                                                                                            | Phase |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----- |
| LLM Orchestration Layer   | Provider abstraction (Anthropic primary, pluggable fallback), model tiering (Haiku/Sonnet), circuit breaker, retry | 2     |
| Prompt Registry           | Versioned prompt library in `prompts/` — prompts are first-class artifacts with tests                              | 2     |
| AI Call Instrumentation   | Per-call: model, tokens in/out, latency, cost, cached vs fresh                                                     | 2     |
| AI Response Caching       | Identical inputs → cached outputs (translation, classification)                                                    | 3     |
| Token Tracking            | Per-request token accounting for cost visibility                                                                   | 3     |
| Enhanced Moderation       | Multi-model classification with structured categories + confidence scores                                          | 3     |
| RAG Foundation            | Document chunking, context injection, retrieval pipeline                                                           | 4     |
| Embedding Store           | pgvector extension on Supabase for semantic search and personalization                                             | 4     |
| Game-Specific RAG         | Game rules, hints, adaptive content fed through RAG into AI                                                        | 5     |
| Token Budget System       | Per-subscription-tier token allowances, enforcement, overage handling                                              | 6     |
| AI Quality Monitoring     | Hallucination detection, response quality tracking, user satisfaction                                              | 7     |
| Cost Attribution          | Token cost per player, per feature, per game — dashboards                                                          | 7     |
| Conversational Onboarding | Adaptive tutorials, in-game AI help                                                                                | 8     |
| In-Game AI Support        | Rules assistant, dispute resolution, contextual help                                                               | 8     |
| Anti-Cheat                | Anomaly detection on player behavior patterns                                                                      | 8     |
| AI Hardening              | Fallback chains, circuit breakers, model degradation gracefully                                                    | 9     |

### GenAI Touchpoints Across the Platform

| Layer                  | Application                                                     | Phase |
| ---------------------- | --------------------------------------------------------------- | ----- |
| Admin UI               | GenAI command bar (natural language → plan → confirm → execute) | ✅ 1  |
| Content Moderation     | Multi-layer safety classifier with structured output            | 2–4   |
| AI Opponent            | LLM-driven adaptive opponent behavior                           | 5     |
| Content Generation     | Dynamic hints, narratives, flavor text                          | 5     |
| Personalization        | Player experience adapted via behavior, skill, preferences      | 7     |
| Analytics Intelligence | Natural language querying ("how did I do this week?")           | 7     |
| Onboarding             | Conversational tutorials, adaptive help                         | 8     |
| Support                | In-game AI assistant for rules, help, disputes                  | 8     |
| Anti-Cheat             | Anomaly detection on player behavior                            | 8     |

### Current State (Phase 1 baseline)

| What Exists                                     | Limitation                                                      |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `app/api/admin/ai/route.ts` — admin command bar | 200-line inline system prompt, raw `fetch()`, no fallback       |
| `lib/safety.ts` — content safety check          | Single API call, binary safe/unsafe, no structured categories   |
| `prompts/README.md` — empty placeholder         | No prompt library exists                                        |
| No LLM abstraction layer                        | Every AI call is a direct Anthropic fetch with hardcoded config |
| No caching                                      | Identical classification requests re-call the API every time    |
| No cost tracking                                | Unknown cost per request, per player, per feature               |

### Target Architecture

```
platform/ai/
  ├── provider.ts         — LLM provider interface (Anthropic, future: OpenAI, local)
  ├── orchestrator.ts     — Model selection, tiering, circuit breaker, retry
  ├── cache.ts            — Response cache (LRU + TTL, Redis in Phase 2+)
  ├── instrumentation.ts  — Per-call metrics: model, tokens, latency, cost
  ├── token-budget.ts     — Per-tier allowances and enforcement (Phase 6)
  └── rag.ts              — Retrieval-augmented generation pipeline (Phase 4)

prompts/
  ├── safety/
  │   ├── classify-v1.ts  — Content classification prompt (versioned)
  │   └── classify-v1.test.ts
  ├── admin/
  │   ├── command-bar-v1.ts
  │   └── command-bar-v1.test.ts
  └── index.ts            — Prompt registry with version resolution
```

## Consequences

- Phase 2 must include the LLM orchestration layer as infrastructure — not optional
- All existing raw `fetch()` AI calls must be refactored through the orchestration layer
- Prompts extracted from inline strings into versioned, tested artifacts
- Every AI call automatically instrumented (no opt-in required)
- Model tiering decisions (Haiku vs Sonnet) made per-use-case, not globally
- Cost visibility from Phase 2 onward — no more unknown AI spend
