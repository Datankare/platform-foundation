# ADR-016: Content Safety Architecture

## Status: Accepted

## Date: 2026-04-03

## Context

Playform's content safety was identified as requiring multi-layer defense, not a single check. During the Phase 1 review, an honest audit revealed that the current safety system is a single Anthropic API call with binary safe/unsafe output, applied at one route only. This is insufficient for a platform that targets all age groups including minors.

The commitment: treat all users as potentially minors from a content perspective — simplifies compliance and raises the safety floor for everyone.

## Decision

### Multi-Layer Defense Architecture

```
User input
  → Layer 1: Blocklist scan (instant, zero-cost, catches known patterns)
  → Layer 2: LLM classifier (structured categories + confidence score)
  → Layer 3: Content rating filter (age-appropriate for player's tier)
  → Decision: allow / warn / block / escalate-to-human
  → Audit: full record (input hash, classifier output, confidence, action)
  → If blocked: increment player strike counter
  → If strikes > threshold: warn → suspend → ban
  → If disputed: enter human review queue with appeal path
```

### Layer Details

| Layer                 | Mechanism                                                                                                                                                                          | Latency   | Cost       | Phase |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | ----- |
| Blocklist             | Pattern + keyword matching against known bad patterns                                                                                                                              | < 1ms     | Zero       | 2     |
| LLM Classifier        | Anthropic classification with structured JSON output: categories (harassment, sexual, violence, self-harm, hate, dangerous), confidence (0–1), severity (low/medium/high/critical) | 200–500ms | Per-call   | 2     |
| Content Rating Filter | Player's COPPA content rating level (1/2/3) sets classifier thresholds — stricter for minors                                                                                       | < 1ms     | Zero       | 3     |
| Human Review Queue    | Admin UI for edge cases, appeals, and moderation decisions                                                                                                                         | N/A       | Staff time | 4     |

### Technical Approach

| Priority  | Mechanism                                                                          | Status                       |
| --------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| Primary   | Anthropic classification with structured output (categories, confidence, severity) | Phase 2: refactor safety.ts  |
| Secondary | Custom keyword/pattern blocklist for known bad patterns — instant pre-screen       | Phase 2: new module          |
| Tertiary  | Human review queue for edge cases and appeals                                      | Phase 4: admin moderation UI |

### Input Surfaces (all must be screened)

| Surface                                 | Current Coverage         | Phase                    |
| --------------------------------------- | ------------------------ | ------------------------ |
| Text translation input (`/api/process`) | ✅ Covered (binary only) | 2: upgrade to structured |
| Voice transcription output              | ❌ Not covered           | 2                        |
| File extraction output                  | ❌ Not covered           | 2                        |
| Game chat (real-time)                   | ❌ Not covered           | 8                        |
| Profile fields (display name, bio)      | ❌ Not covered           | 3                        |
| User-generated game content             | ❌ Not covered           | 5                        |

### Account Consequences System

| Strike Count | Action                      | Reversible              | Phase |
| ------------ | --------------------------- | ----------------------- | ----- |
| 1            | Warning shown to user       | Yes                     | 4     |
| 2            | 24-hour content restriction | Yes (automatic)         | 4     |
| 3            | 7-day suspension            | Yes (admin review)      | 4     |
| 4+           | Permanent ban               | Appeal via human review | 4     |

### Audit Trail Requirements

Every moderation decision must be permanently logged with:

| Field                   | Description                                           | Phase |
| ----------------------- | ----------------------------------------------------- | ----- |
| `input_hash`            | SHA-256 of input (not raw content — privacy)          | 2     |
| `classifier_output`     | Full structured response from LLM classifier          | 2     |
| `confidence_score`      | Classifier confidence (0–1)                           | 2     |
| `categories_flagged`    | Which categories triggered (harassment, sexual, etc.) | 2     |
| `severity`              | low / medium / high / critical                        | 2     |
| `action_taken`          | allow / warn / block / escalate                       | 2     |
| `player_content_rating` | Player's COPPA tier at time of check                  | 3     |
| `player_strike_count`   | Cumulative strikes at time of check                   | 4     |
| `reviewer_id`           | If human-reviewed, who reviewed                       | 4     |
| `appeal_status`         | If appealed, outcome                                  | 4     |

### Current State (Phase 1 baseline)

| What Exists                                 | Limitation                                                         |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `lib/safety.ts` — single Anthropic API call | Binary safe/unsafe. No structured categories. No confidence score. |
| Applied at `/api/process` only              | Voice, file upload, profile, game chat — all unscreened            |
| `audit_log` — immutable table               | Logs pass/fail only. Classifier output not recorded.               |
| COPPA content rating levels (1/2/3)         | Not enforced in safety check — every user gets same threshold      |
| No blocklist                                | Every check costs an API call, even for obvious violations         |
| No strike system                            | One response only: "Content not allowed" (422)                     |
| No human review                             | No appeal path, no moderation queue                                |

### Phase Mapping

| Phase | Deliverable                                                                            |
| ----- | -------------------------------------------------------------------------------------- |
| 2     | `platform/moderation/blocklist.ts` — instant keyword/pattern pre-screen                |
| 2     | Refactor `safety.ts` → structured classifier output (categories, confidence, severity) |
| 2     | Safety middleware — universal, applied at every input surface                          |
| 2     | Audit trail: full classifier output logged per decision                                |
| 3     | Content rating integration — COPPA tier adjusts classifier thresholds                  |
| 3     | Profile field screening (display name, bio)                                            |
| 4     | `platform/moderation/` — human review queue, admin moderation UI                       |
| 4     | Account consequences — strike counter, warn → suspend → ban                            |
| 4     | User reporting — report button, feeds moderation queue                                 |
| 4     | Appeal workflow — player submits appeal, human reviewer decides                        |
| 5     | User-generated game content screening                                                  |
| 8     | Real-time moderation for multiplayer game chat (sub-100ms)                             |
| 9     | Legal audit hardening — full audit trail exportable for discovery, retention policy    |

## Consequences

- Phase 2 must include the safety middleware refactor — not optional
- Every new input surface added in any phase must integrate safety middleware from day one
- Blocklist runs before LLM classifier — reduces AI costs for obvious violations
- Structured classifier output enables aggregation, analysis, and tiered enforcement
- Full audit trail provides legal defensibility for moderation decisions
- The "treat all as minors" principle means the base safety threshold is strict — age tiers only relax it for verified adults, never lower it
