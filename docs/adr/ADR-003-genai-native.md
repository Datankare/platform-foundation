# ADR-003 — GenAI-Native Architecture

**Status:** Accepted
**Date:** 2026-03-18

## Context

Most platforms treat AI as a feature — an add-on chatbot or recommendation
engine. We believe AI is infrastructure, not a feature. The platform handles
voice input, multilingual content, content moderation, AI opponents, adaptive
onboarding, and natural language analytics. All of these require LLM capabilities.

## Decision

GenAI is woven into the platform fabric from day one:

- **Primary LLM:** Anthropic Claude API — AI opponent, content safety,
  intent extraction, NL analytics, conversational onboarding
- **STT:** Web Speech API (browser) + Google STT (mobile/fallback)
- **Translation:** Google Translate API + Claude for contextual nuance
- **TTS:** Google Cloud TTS — Neural2 voices in all supported languages
- **Prompt management:** Versioned prompt library in /prompts — prompts
  are first-class repository artifacts
- **AI cost management:** Token budgets per interaction, response caching,
  model tiering (Haiku for simple, Sonnet for complex)
- **Fallback:** Graceful degradation when any AI service is unavailable

## Consequences

- Voice and multilingual capabilities are first-class, not bolt-ons
- Content safety is LLM-powered — context-aware, not just keyword matching
- AI costs must be monitored and budgeted from day one
- Prompt injection defense required at every AI input surface
- Platform has genuine competitive differentiation from day one
