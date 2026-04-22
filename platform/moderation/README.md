# moderation

Content safety — agentic multi-layer defense architecture (ADR-016).

## Status

✅ **Guardian agent + Layers 1–3 complete** (Phase 4, Sprint 2). Human review queue planned for Sprint 6.

## Architecture

The Guardian is an autonomous agent (P15, P18) that screens content through a multi-layer pipeline with context-aware reasoning.

```
platform/moderation/
  ├── guardian.ts       — Guardian agent: identity, trajectory, reasoning
  ├── context.ts        — Content-type severity adjustments
  ├── config.ts         — Config loader from platform_config (no hardcoded thresholds)
  ├── blocklist.ts      — Layer 1: Keyword/pattern pre-screen (instant, zero-cost)
  ├── classifier.ts     — Layer 2: Structured LLM classifier
  ├── middleware.ts      — screenContent() — thin wrapper delegating to Guardian
  ├── audit.ts          — Dual-write audit trail (logger + ModerationStore)
  ├── store.ts          — ModerationStore provider (InMemory + Supabase)
  ├── types.ts          — All types: ScreeningContext, ContentType, ModerationResult
  └── index.ts          — Public API
```

## Guardian Agent Trajectory (P18)

```
Step 0: receive-context     (cognition)  — evaluate content type, user history
Step 1: blocklist-scan      (cognition)  — instant pattern matching
Step 2: classify-content    (cognition)  — LLM classifier (skipped if blocklist blocks)
Step 3: evaluate-thresholds (cognition)  — apply content rating + context adjustments
Step 4: decide              (commitment) — final action with human-readable reasoning
```

## Content Types

| Type            | Behavior                                                               | User Strikes |
| --------------- | ---------------------------------------------------------------------- | ------------ |
| `translation`   | Severity reduced (configurable) — user is translating existing content | Yes          |
| `generation`    | Standard — user is creating content                                    | Yes          |
| `transcription` | Severity reduced — STT artifacts cause false positives                 | Yes          |
| `extraction`    | Severity reduced — content is from uploaded document                   | Yes          |
| `profile`       | Standard (future: stricter URL/impersonation patterns)                 | Yes          |
| `social`        | Standard (future: conversation thread context)                         | Yes          |
| `ai-output`     | Standard — but **no user strikes** on block (platform quality issue)   | No           |

## Configuration

All thresholds are in the `platform_config` table (category: `moderation`).
Code has **no hardcoded thresholds** — if the database is unavailable, the system
fails closed to the strictest possible values.

Seed defaults are in `supabase/migrations/010_content_safety_audit.sql`.

## Gotchas

1. **`collectCoverageFrom` must include `platform/moderation/**/\*.ts`\*\* — gotcha #24.
2. **Fail closed everywhere** — unknown rating = strictest. DB unavailable = block at low severity. Classifier error = unsafe.
3. **`triggeredBy: "content-rating"`** — when Layer 3 adjusts the decision. **`"context"`** — when content-type adjustment changed the outcome.
4. **AI-output never penalizes users** — `attributeToUser: false` for `contentType: "ai-output"`.
5. **Config reads are cached 60s** — threshold changes take up to 60s to propagate.
6. **Guardian is stateless between calls** — each `screen()` creates a fresh trajectory.

---

_See [ADR-016](../../docs/adr/ADR-016-content-safety-architecture.md) for architecture context._

_Last updated: April 22, 2026 (Sprint 2: Guardian agent, agentic moderation)_
