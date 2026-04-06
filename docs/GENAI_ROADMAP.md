# GenAI-Native Roadmap

**Owner:** Raman Sud, CTO
**Canonical location:** `docs/GENAI_ROADMAP.md` (both platform-foundation and playform repos)
**Governing ADRs:** ADR-003 (GenAI-Native), ADR-015 (GenAI-Native Stack), ADR-017 (Complete Surface Map)
**Rule:** Updated at every sprint boundary. No GenAI capability is built without placement here first (Standing Rule 12).

---

## The GenAI-Native Principle

GenAI is the medium the platform operates in — not a feature bolted on. Every player interaction, every admin action, every safety decision, every piece of content flows through AI infrastructure that is instrumented, cached, budgeted, monitored, resilient, and explainable.

---

## Phase Summary

| Phase | GenAI Status              | Key GenAI Capabilities                                                       |
| ----- | ------------------------- | ---------------------------------------------------------------------------- |
| 1     | ✅ Complete               | Admin AI command bar                                                         |
| 2     | 🔄 Sprint 2 of 6 complete | Orchestration layer, prompt registry, structured safety, moderation pipeline |
| 3     | ⏳ Upcoming               | Multi-language AI, eval framework, response caching, token tracking          |
| 4     | ⏳ Upcoming               | RAG, embeddings, player context, explainability                              |
| 5     | ⏳ Upcoming               | AI opponent, content generation, agentic framework, multimodal               |
| 6     | ⏳ Upcoming               | Token budgets, cost attribution, A/B testing                                 |
| 7     | ⏳ Upcoming               | AI quality monitoring, personalization, feedback loop, NL analytics          |
| 8     | ⏳ Upcoming               | Conversational onboarding, in-game AI support, anti-cheat                    |
| 9     | ⏳ Upcoming               | AI hardening, fallback chains, graceful degradation                          |

---

## Phase 1 — Identity & Access Foundation ✅

| Capability           | Status       | Detail                                                                                                     |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| Admin AI command bar | ✅ Delivered | Natural language → structured plan → human confirm → execute. Admin operations flow through AI, not forms. |

---

## Phase 2 — Communication Foundation 🔄

| Capability                     | Status       | Detail                                                                                                     |
| ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------- |
| LLM orchestration layer        | ✅ Sprint 1  | `platform/ai/orchestrator.ts` — provider abstraction, model tiering (Haiku/Sonnet), circuit breaker, retry |
| Provider interface             | ✅ Sprint 1  | `platform/ai/provider.ts` — Anthropic primary, pluggable fallback. No raw `fetch()` to LLM APIs.           |
| AI call instrumentation        | ✅ Sprint 1  | Every AI call auto-records: model, tokens in/out, latency, estimated cost, success/failure                 |
| Prompt registry                | ✅ Sprint 1  | `prompts/` — versioned prompts with tests, registry with version resolution                                |
| Admin AI refactored            | ✅ Sprint 1  | Raw `fetch()` + inline prompt → orchestrator + prompt registry                                             |
| Safety classifier refactored   | ✅ Sprint 1  | Anthropic SDK direct call → orchestrator. Structured output: 6 categories, confidence, severity            |
| Blocklist pre-screen (Layer 1) | ✅ Sprint 2  | `platform/moderation/blocklist.ts` — instant, zero-cost pattern matching. safe-regex2 validated.           |
| LLM classifier (Layer 2)       | ✅ Sprint 2  | `platform/moderation/classifier.ts` — structured classification via orchestrator                           |
| Safety middleware              | ✅ Sprint 2  | `platform/moderation/middleware.ts` — universal pipeline for input AND output screening (ADR-017)          |
| Moderation audit trail         | ✅ Sprint 2  | SHA-256 hashed input, full classifier output, action, direction logged per decision                        |
| Streaming responses            | ⏳ Sprint 3+ | `provider.stream()` alongside `complete()`, time-to-first-token instrumentation                            |

---

## Phase 3 — Language & Voice Foundation ⏳

| Capability              | Status     | Detail                                                                                       |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| AI response caching     | ⏳ Planned | Identical inputs → cached outputs. Translation and classification are highly cacheable.      |
| Token tracking          | ⏳ Planned | Per-request token accounting for cost visibility before monetization phase                   |
| Enhanced moderation     | ⏳ Planned | Multi-model classification with confidence score aggregation                                 |
| Multi-language AI       | ⏳ Planned | Safety classification and AI interactions operate in player's language natively (ADR-017 §3) |
| AI evaluation framework | ⏳ Planned | `prompts/evals/` with datasets per prompt, regression runs in CI (ADR-017 §4)                |

---

## Phase 4 — Content Safety Foundation ⏳

| Capability               | Status     | Detail                                                                                                    |
| ------------------------ | ---------- | --------------------------------------------------------------------------------------------------------- |
| RAG foundation           | ⏳ Planned | Document chunking, context injection, retrieval pipeline                                                  |
| Embedding store          | ⏳ Planned | pgvector extension on Supabase for semantic search and personalization                                    |
| Player AI context store  | ⏳ Planned | Per-player interaction history, learning patterns, preferences — injected into AI prompts (ADR-017 §5)    |
| AI output explainability | ⏳ Planned | Explanation chain for every AI decision — why was content blocked, why did difficulty adjust (ADR-017 §6) |

---

## Phase 5 — Game Engine Abstraction ⏳

| Capability                 | Status     | Detail                                                                                     |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| AI opponent                | ⏳ Planned | LLM-driven adaptive opponent behavior — adjusts to player skill and style                  |
| Content generation         | ⏳ Planned | Dynamic hints, narratives, flavor text — no two players see the same static content        |
| Game-specific RAG          | ⏳ Planned | Game rules, hint systems, adaptive content fed through RAG into AI                         |
| Agentic workflow framework | ⏳ Planned | `platform/ai/agent.ts` — tool registry, multi-step execution, state, rollback (ADR-017 §7) |
| Multimodal AI              | ⏳ Planned | Image/audio input in provider interface, image generation (ADR-017 §8)                     |

---

## Phase 6 — Monetization Foundation ⏳

| Capability                | Status     | Detail                                                                       |
| ------------------------- | ---------- | ---------------------------------------------------------------------------- |
| Token budget system       | ⏳ Planned | Per-subscription-tier token allowances, enforcement at orchestration layer   |
| Cost attribution per tier | ⏳ Planned | Know how much AI each subscription tier actually consumes                    |
| AI A/B testing            | ⏳ Planned | Split-test prompt versions and model tiers against live traffic (ADR-017 §9) |

---

## Phase 7 — Analytics Foundation ⏳

| Capability             | Status     | Detail                                                                                  |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------- |
| AI quality monitoring  | ⏳ Planned | Hallucination detection, user satisfaction signals, response quality tracking           |
| Analytics intelligence | ⏳ Planned | Natural language querying — "how did I do this week?"                                   |
| Personalization        | ⏳ Planned | Player experience adapted via behavior, skill, preferences                              |
| Player feedback loop   | ⏳ Planned | Thumbs up/down, correction tracking, appeal outcomes feeding into quality (ADR-017 §10) |
| Cost dashboards        | ⏳ Planned | Token cost per player, per feature, per game                                            |

---

## Phase 8 — Game 1 Implementation ⏳

| Capability                | Status     | Detail                                                                  |
| ------------------------- | ---------- | ----------------------------------------------------------------------- |
| Conversational onboarding | ⏳ Planned | Adaptive tutorials that adjust to what the player already knows         |
| In-game AI support        | ⏳ Planned | Rules assistant, dispute resolution, contextual help — always available |
| Anti-cheat                | ⏳ Planned | Anomaly detection on player behavior patterns                           |

---

## Phase 9 — Hardening & Launch ⏳

| Capability               | Status     | Detail                                                                  |
| ------------------------ | ---------- | ----------------------------------------------------------------------- |
| AI hardening             | ⏳ Planned | Fallback chains across providers, graceful model degradation            |
| Chaos engineering for AI | ⏳ Planned | Deliberately break AI in staging — verify fallback and degradation work |

---

## Phase 9 Verification Checklist (ADR-017)

At launch, every one of these must be true:

| #   | Statement                                                                    | Verified |
| --- | ---------------------------------------------------------------------------- | -------- |
| 1   | No raw LLM API call exists anywhere in the codebase                          | [ ]      |
| 2   | Every AI call is instrumented with model, tokens, cost, latency              | [ ]      |
| 3   | Every AI input AND output is safety-screened                                 | [ ]      |
| 4   | Every prompt is versioned, tested, and has an eval dataset                   | [ ]      |
| 5   | AI operates in the player's language natively                                | [ ]      |
| 6   | AI remembers player context across sessions                                  | [ ]      |
| 7   | AI decisions are explainable to admins and players                           | [ ]      |
| 8   | AI supports streaming for conversational surfaces                            | [ ]      |
| 9   | AI supports multimodal input and output                                      | [ ]      |
| 10  | Multi-step AI workflows use the agentic framework                            | [ ]      |
| 11  | Prompt changes are A/B tested against live traffic                           | [ ]      |
| 12  | Player feedback flows back into AI quality improvement                       | [ ]      |
| 13  | AI is resilient — fallback providers, circuit breakers, graceful degradation | [ ]      |
| 14  | AI cost is tracked per player, per feature, per game, per subscription tier  | [ ]      |

If any statement is false at Phase 9, GenAI-native is incomplete.

---

## Changelog

| Date       | Author    | Change                                                                                                                  |
| ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-04-06 | Raman Sud | Initial GenAI roadmap — extracted from ADR-015, ADR-017, and ROADMAP.md. Phase 1 complete, Phase 2 Sprint 1+2 complete. |
