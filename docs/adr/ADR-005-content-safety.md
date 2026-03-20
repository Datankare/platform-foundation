# ADR-005 — Content Safety Architecture

**Status:** Accepted
**Date:** 2026-03-18

## Context

The platform is strictly SFW (Safe For Work) and must remain so across all
input modalities (text and voice), all languages, and all game types. Content
safety must work in real time, before content reaches other players, and must
handle multilingual input correctly.

## Decision

Multi-layer content safety architecture:

1. **Primary classifier:** Claude API (claude-haiku) — context-aware,
   multilingual, operates on original language before translation
2. **Fail-closed:** If the safety classifier returns an unparseable response,
   the content is BLOCKED — not allowed through. When in doubt, reject.
3. **Pre-translation screening:** Safety check runs on the original input
   before any translation occurs — prevents evasion via language mixing
4. **Markdown fence stripping:** LLM responses are cleaned before JSON parsing
   to handle code fence wrapping
5. **Audit trail:** All moderation decisions logged permanently
6. **Tiered consequences:** warn → suspend → ban with appeal path

The safety check is the FIRST step in the processing pipeline — before
translation, before TTS, before any content reaches other players.

## Consequences

- No sexual, violent, hateful, or inappropriate content can reach players
- Multilingual evasion attempts are caught at the source language level
- False positives are possible — the appeal path mitigates this
- Adds latency to every submission — acceptable given safety requirement
- Claude API costs must account for safety classification on every input
- Safety tests must cover known bad inputs in all supported languages
