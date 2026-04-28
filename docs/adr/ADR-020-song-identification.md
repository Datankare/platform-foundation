# ADR-020: Song Identification Architecture

**Status:** Accepted
**Date:** 2026-04-16
**Decision Makers:** Raman Sud
**Sprint:** Phase 3 Sprint 4a

## Context

Playform needs to identify songs from ambient audio captured via the browser. Users tap "Identify" and the platform records a short clip, identifies the song, and returns title/artist/album metadata.

This requires:

1. **Audio format conversion** — browsers record WebM/Opus; identification providers need WAV/PCM
2. **Audio fingerprint matching** — a third-party provider with a music database
3. **Privacy controls** — audio contains ambient sound that may include speech
4. **Rate limiting** — each identification is an API call with per-request cost

## Decision

### Canonical Audio Format

All audio entering the platform is normalized to **WAV 16kHz mono 16-bit PCM** before any processing. This is a platform decision, not a provider decision:

- Strips all container metadata (WebM headers, Opus metadata, ID3 tags)
- Ensures consistent input to all downstream consumers (STT, song ID, future analysis)
- Privacy by design: canonical conversion removes device/software identifiers embedded in containers

Conversion is performed by the `AudioFormatConverter` provider interface, defaulting to the `ffmpeg-service` deployment at `ffmpeg.datankare.com` (ECS Fargate). Uses `fetchWithTimeout` per platform convention (not raw fetch).

### Song Identification Provider

**Primary:** ACRCloud (`identify-us-west-2.acrcloud.com`)
**Interface:** `SongIdentificationProvider` — swap to AudD.io or future providers via `SONG_ID_PROVIDER` env var.

ACRCloud was selected over AudD.io for higher recognition accuracy on partial/noisy audio and better music database coverage.

### Privacy Controls (built in, not bolted on)

1. Audio exists in memory only during the request lifecycle — never persisted
2. Metadata stripping occurs during canonical format conversion
3. Maximum 15-second clip sent to ACRCloud (enforced in provider via `enforceClipLimit`)
4. Explicit user consent required (tap "Identify" action)
5. Audit logs record who, when, and match result — **never** audio content
6. Provider isolation: ACRCloud receives only canonical WAV bytes with no user, session, or device information

### Rate Limiting (P13)

`SONG_IDENTIFY` rule added to `DEFAULT_RULES` in `platform/rate-limit/types.ts`: 10 identifications per user per hour. Enforcement wired via `getRateLimiter().check(userId, DEFAULT_RULES.SONG_IDENTIFY)` at the API route layer.

Rationale:

- Each identification sends unique audio — no caching possible
- At $0.01/request on paid tier, unrestricted usage creates cost risk
- Future: tier-based limits (free: 10/hr, subscriber: 30/hr)

### Cost Model (P5)

Every `IdentifyResult` and `ConversionResult` includes `estimatedCostUsd`:

| Provider         | Cost per call | Notes              |
| ---------------- | ------------- | ------------------ |
| ACRCloud         | ~$0.01        | Paid tier estimate |
| FFmpeg service   | $0.00         | Self-hosted on ECS |
| Mock/Passthrough | $0.00         | No external call   |

| Tier           | Requests/Day | Monthly Cost | Phase            |
| -------------- | ------------ | ------------ | ---------------- |
| Free (current) | 100          | $0           | Development      |
| Basic          | 3,000        | ~$30         | Demo/early users |
| Pro            | 30,000       | ~$100        | Growth           |

### Provider Registry

Two new slots added (total: 10):

| Slot            | Env Var            | Options                             | Default |
| --------------- | ------------------ | ----------------------------------- | ------- |
| Song ID         | `SONG_ID_PROVIDER` | acrcloud / mock                     | mock    |
| Audio Converter | `AUDIO_CONVERTER`  | ffmpeg-service / passthrough / mock | mock    |

### Identification Cache (P16)

`IdentifyCache` interface defined for fingerprint dedup. Primary use case: user taps "Identify" twice in quick succession. Key = audio hash, TTL = 5-10 minutes. Real implementation wired at Playform route layer. Interface is in `identify-types.ts`.

### Health Probes

`checkSongIdHealth` and `checkAudioConverterHealth` added to `health-probe.ts`, following the existing pattern for translation/TTS/STT probes. Both use connectivity-vs-validation error distinction: non-connectivity errors (validation, format) are treated as "healthy" (provider is reachable).

## GenAI Principle Compliance

| #   | Principle               | Implementation                                               |
| --- | ----------------------- | ------------------------------------------------------------ |
| P1  | Orchestration only      | All song ID through SongIdentificationProvider               |
| P2  | Every call instrumented | Latency, confidence, match/no-match rate, audio size         |
| P3  | Safety at I/O           | Audio metadata stripped before sending to ACRCloud           |
| P5  | Cost tracking           | `estimatedCostUsd` in IdentifyResult + ConversionResult      |
| P6  | Structured output       | SongMatch result type                                        |
| P7  | Provider abstraction    | SongIdentificationProvider + AudioFormatConverter interfaces |
| P9  | Observable              | Per-call tracing with requestId                              |
| P10 | Testable                | MockSongIdentifier + MockAudioConverter                      |
| P11 | Graceful degradation    | No match = null result (not error)                           |
| P12 | Content safety          | Canonical format strips all container metadata               |
| P13 | Rate limiting           | `SONG_IDENTIFY` rule in DEFAULT_RULES (10/user/hour)         |
| P14 | Audit trail             | Log who, when, result — never audio content                  |
| P15 | Agent identity          | actorType/actorId/onBehalfOf on every request                |
| P16 | Cognitive memory        | IdentifyCache interface for fingerprint dedup                |
| P17 | Intent mapping          | `IDENTIFY_INTENT = "inform"` constant exported               |
| P18 | Durable trajectories    | trajectoryId/stepIndex on request and result                 |

## Infrastructure

| Service        | Endpoint                                              | Notes                           |
| -------------- | ----------------------------------------------------- | ------------------------------- |
| FFmpeg service | `https://ffmpeg.datankare.com/convert`                | ECS Fargate, X-Service-Key auth |
| ACRCloud       | `https://identify-us-west-2.acrcloud.com/v1/identify` | HMAC-SHA1 signed                |

Both providers use `fetchWithTimeout` from `@/lib/fetchWithTimeout` (not raw fetch), getting retry + timeout + logging for free.

## Consequences

### Positive

- Provider abstraction enables swap to AudD.io or on-device fingerprinting without code changes
- Canonical format ensures all audio consumers get consistent input
- Privacy controls are structural (metadata stripped during conversion) not procedural
- Rate limiting via existing `RateLimiter` infrastructure (memory + Redis backends)
- Cost tracked per-call for budget monitoring

### Negative

- Audio format conversion adds ~200ms latency per request
- ACRCloud free tier limited to 100 requests/day (sufficient for development)
- No lyrics, streaming links, or album art (require separate licensing)

### Risks

- ✅ ACRCloud migrated to paid project `playform-prod-songid` on 2026-04-25. Free trial (project 99216) deprovisioned.
- ✅ `ACRCLOUD_ACCESS_SECRET` rotated 2026-04-25 (TASK-026 closed). See ROTATION_RUNBOOK.md.

## Alignment with Playform

Playform's `classifyMeta.ts` already defines `ContentType = "LYRICS"` and `SourceType = "song"`. The `ClassificationResult.source` (title) + `sourceDetail` (artist) maps to `SongMatch.title` + `SongMatch.artist`. These are complementary pipelines — text classification detects "this is lyrics" while song ID detects "this audio is a specific song." Convergence happens at the Playform API route layer, not in PF.

## References

- PHASE3_PLAN.md — Sprint 4 deliverables
- GENAI_MANIFESTO.md — 18 principles
- ADR-019 — Voice Pipeline Architecture (Sprint 3)
- ENGINEERING_LEARNINGS.md — L11 (read consumer before building), L13 (AUX assessment)
