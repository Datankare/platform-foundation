# ADR-017: Complete GenAI-Native Surface Map

## Status: Accepted

## Date: 2026-04-05

## Context

During Phase 2 Sprint 1, a comprehensive audit revealed that the GenAI-native commitment (ADR-003, ADR-015) had significant gaps. While the orchestration layer, prompt registry, and structured safety classification were delivered, the roadmap lacked coverage for ten critical GenAI capabilities that a truly GenAI-native platform must have.

The root cause: we built GenAI-native fabric incrementally per phase without first defining the complete surface map. This ADR corrects that by enumerating every GenAI surface — input, output, infrastructure, and intelligence — and assigning each to a phase. After this ADR, no GenAI capability should be "discovered" in a later phase.

### The GenAI-Native Principle (restated)

GenAI is the medium the platform operates in, not a feature bolted on. Every player interaction, every admin action, every safety decision, every piece of content flows through AI infrastructure that is instrumented, cached, budgeted, monitored, resilient, and explainable.

## Decision

### Complete GenAI Surface Map

Ten capabilities were missing from the roadmap. Each is assigned to the earliest phase where it can be meaningfully delivered, with infrastructure in PF and application-specific use in Playform.

#### 1. AI Output Screening (Phase 2)

**Gap:** ADR-016 screens every input. But AI-generated content — game hints, onboarding dialogue, admin command bar responses, dynamic narratives — goes directly to the player with no safety screening.

**Requirement:** Every AI response passes through the same multi-layer safety pipeline before reaching the user. Output screening is safety fabric, not optional.

**Placement:** Phase 2, Sprint 2 (Content Safety Refactor). The safety middleware must screen both input and output. Add `direction: "input" | "output"` to the middleware contract.

#### 2. Streaming Responses (Phase 2)

**Gap:** The orchestrator is request/response only. Every conversational surface waits for the full response. For a game platform where AI is the interaction medium, that latency kills the experience.

**Requirement:** The orchestrator supports streaming alongside request/response. Streaming is opt-in per call — callers that need progressive rendering (chat, onboarding, admin command bar) use it; callers that need complete output (safety classification, data extraction) don't.

**Placement:** Phase 2 (extend orchestrator). The provider interface gains a `stream()` method alongside `complete()`. Instrumentation tracks streaming calls with time-to-first-token and total duration.

#### 3. Multi-Language AI (Phase 3)

**Gap:** The AI operates in English. Safety classification, admin commands, game AI, and onboarding are all English-first. A Spanish-speaking player gets English-classified safety decisions and English AI help translated after the fact.

**Requirement:** Safety classification operates in the player's language. AI interactions (onboarding, support, game AI) are generated in the player's language natively, not translated post-hoc.

**Placement:** Phase 3 (Language & Voice Foundation). The prompt registry gains language-aware prompt variants. The orchestrator passes a `language` parameter. Safety prompts include multilingual category definitions.

#### 4. AI Evaluation Framework (Phase 3)

**Gap:** Prompt tests verify parsing works. No systematic evaluation pipeline exists. When classify-v2 replaces classify-v1, there's no way to prove it's better across hundreds of edge cases.

**Requirement:** Every prompt has an eval dataset — a set of inputs with expected outputs. Prompt version changes require eval regression runs. Eval results are tracked over time.

**Placement:** Phase 3. The `prompts/` directory gains an `evals/` subdirectory. Eval datasets are versioned alongside prompts. CI runs evals on prompt changes. Results feed into the observability fabric.

#### 5. Player AI Context Store (Phase 4)

**Gap:** RAG in Phase 4 injects documents into prompts. But there's no persistent AI memory per player. Each AI interaction starts cold. The game AI won't remember that this player struggles with verb conjugations or prefers visual hints.

**Requirement:** A per-player context store that accumulates AI-relevant signals: learning patterns, preference signals, interaction history, skill assessments. This context is injected into AI prompts alongside RAG content.

**Placement:** Phase 4 (alongside RAG + embedding store). Player context stored as embeddings in pgvector. Context injection is a standard parameter in the orchestrator: `playerContext?: string`.

#### 6. AI Output Explainability (Phase 4)

**Gap:** The audit trail logs what happened (input hash, classification, action) but not why in a way useful to admins, players filing appeals, or developers debugging AI behavior.

**Requirement:** AI decisions include an explanation chain: why was this content blocked? Why did the game AI adjust difficulty? Why did personalization change the experience? Explanations stored alongside audit records.

**Placement:** Phase 4 (Content Safety Foundation — human review queue needs explainability). The ClassifierOutput gains an `explanation` field. Admin moderation UI displays the explanation chain. Players see a human-readable reason on content blocks.

#### 7. Agentic Workflow Framework (Phase 5)

**Gap:** The admin command bar is plan→confirm→execute — one agentic pattern. No general-purpose agent framework exists. Phase 8 needs it for game AI (multi-step reasoning), dispute resolution (gather evidence → analyze → recommend), and anti-cheat (detect → correlate → escalate).

**Requirement:** A reusable agent framework in PF: tool registry, multi-step execution with state, failure recovery mid-workflow, human-in-the-loop breakpoints.

**Placement:** Phase 5 (Game Engine Abstraction — the game engine is the first consumer of complex agent workflows). `platform/ai/agent.ts` — agent runner with tool registry, step state, rollback.

#### 8. Multimodal AI (Phase 5)

**Gap:** The AI stack is text-in/text-out. A language-learning game platform should understand images (describe this photo in Spanish), generate visual content (vocabulary cards), and process audio natively (not just transcribe-then-classify).

**Requirement:** The provider interface supports multimodal input (images, audio alongside text). The orchestrator routes multimodal requests to capable models. Image generation is a separate provider interface.

**Placement:** Phase 5 (Game Engine — games need visual and audio AI). The `AIProvider` interface gains multimodal content blocks. `AIMessage.content` supports `image` and `audio` block types alongside text.

#### 9. AI A/B Testing (Phase 6)

**Gap:** Prompts can be versioned, but there's no mechanism to split-test two prompt versions or two model tiers against live traffic and measure which performs better.

**Requirement:** The orchestrator supports experiment assignment: a percentage of traffic uses prompt-v2 while the rest uses prompt-v1. Metrics are segmented by experiment arm. Results feed into the analytics pipeline.

**Placement:** Phase 6 (Monetization Foundation — A/B testing is essential for optimizing token spend per tier). The prompt registry gains experiment configuration. The orchestrator resolves prompt version based on experiment assignment.

#### 10. Player Feedback Loop (Phase 7)

**Gap:** Phase 7 mentions "user satisfaction signals" but doesn't specify how player feedback flows back into AI improvement. Without a closed loop, AI quality is static after deployment.

**Requirement:** Players can rate AI responses (thumbs up/down). Appeal outcomes feed back into classifier training data. Translation corrections improve prompt instructions. All feedback is tracked, aggregated, and surfaced in quality dashboards.

**Placement:** Phase 7 (Analytics Foundation — the feedback loop is analytics infrastructure). `platform/ai/feedback.ts` — feedback collection, aggregation, and quality signal generation.

### Complete Phase-by-Phase GenAI Inventory

After this ADR, the complete GenAI surface per phase is:

| Phase | GenAI Capabilities |
| ----- | --- |
| 1 ✅ | Admin command bar (NL → plan → confirm → execute) |
| 2 🔄 | Orchestrator, prompt registry, structured safety, AI output screening, streaming |
| 3 | AI response caching, token tracking, multi-language AI, AI eval framework, enhanced moderation |
| 4 | RAG pipeline, embedding store, player AI context, output explainability |
| 5 | AI opponent, content generation, game-specific RAG, agentic framework, multimodal |
| 6 | Token budgets, cost attribution per tier, AI A/B testing |
| 7 | AI quality monitoring, NL analytics, personalization, player feedback loop, cost dashboards |
| 8 | Conversational onboarding, in-game AI support, anti-cheat |
| 9 | AI hardening (fallback chains, graceful degradation), chaos engineering for AI |

### Verification

At Phase 9, every one of the following statements must be true:

1. No raw LLM API call exists anywhere in the codebase
2. Every AI call is instrumented with model, tokens, cost, latency
3. Every AI input AND output is safety-screened
4. Every prompt is versioned, tested, and has an eval dataset
5. AI operates in the player's language natively
6. AI remembers player context across sessions
7. AI decisions are explainable to admins and players
8. AI supports streaming for conversational surfaces
9. AI supports multimodal input and output
10. Multi-step AI workflows use the agentic framework
11. Prompt changes are A/B tested against live traffic
12. Player feedback flows back into AI quality improvement
13. AI is resilient — fallback providers, circuit breakers, graceful degradation
14. AI cost is tracked per player, per feature, per game, per subscription tier

If any statement is false at Phase 9, GenAI-native is incomplete.

## Consequences

- Phase 2 scope increases: add streaming to orchestrator, add output screening to safety middleware
- Phase 3 scope increases: add eval framework, add multi-language AI
- Phase 4 scope increases: add player context store, add output explainability
- Phase 5 scope increases: add agentic framework, add multimodal provider interface
- Phase 6 scope increases: add A/B testing
- Phase 7 scope increases: add player feedback loop
- ADR-015 is extended, not replaced — this ADR adds the missing surfaces
- ROADMAP.md updated with all new deliverables per phase
- No GenAI capability should be "discovered" after this ADR — this is the complete map
