# Phase 3 — Language & Voice Foundation: Sprint Plan

**Repository:** Datankare/platform-foundation
**Planned Start:** April 2026
**Phase 2 Exit:** v1.3.0 (April 13, 2026)
**Pre-Phase Action:** k6 load test on `/api/process` + `/api/stream` (required by RAMPS Phase 2)

---

## Current State

| Asset                | Status                                            | Location                  | Lines     |
| -------------------- | ------------------------------------------------- | ------------------------- | --------- |
| Translation          | Raw Google API call, 3 languages hardcoded        | `lib/translate.ts`        | 54        |
| TTS                  | Raw Google API call, 3 voice configs              | `lib/tts.ts`              | 46        |
| STT                  | Browser-only Web Speech API                       | `components/SpikeApp.tsx` | inline    |
| Song ID              | Not started                                       | —                         | —         |
| Language configs     | 10 languages in Playform UI, only 3 wired to APIs | `lib/translate.ts`        | hardcoded |
| Provider abstraction | None — translate and TTS bypass orchestration     | —                         | —         |

### Deferred Items Landing in Phase 3

| ID       | Description                                        | Origin        |
| -------- | -------------------------------------------------- | ------------- |
| TASK-020 | Google Cloud TTS 5,000-byte limit — needs chunking | Sprint 4      |
| TASK-013 | Song identification (ACRCloud/AudD.io)             | Phase 0 spec  |
| —        | k6 load test: AI + streaming endpoints             | RAMPS Phase 2 |

---

## Sprint Plan

### Sprint 1: Translation Provider Abstraction

**GenAI Principle Mapping:**

| Principle                    | Application                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| P1 — Orchestration only      | All translation through `TranslationProvider`, never direct API |
| P2 — Every call instrumented | Latency, cost, language pair metrics via MetricsSink            |
| P7 — Provider abstraction    | `TranslationProvider` interface, swappable via env var          |
| P9 — Observable              | Tracing span per translation call                               |

**Deliverables:**

| File                                       | Description                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `platform/translation/types.ts`            | `TranslationProvider` interface: `translate(text, sourceLang, targetLang)`, `detectLanguage(text)`, `getSupportedLanguages()` |
| `platform/translation/google-translate.ts` | Google Translate v2 implementation (wraps existing `lib/translate.ts` logic)                                                  |
| `platform/translation/mock-translate.ts`   | Deterministic mock for tests                                                                                                  |
| `platform/translation/languages.ts`        | Single source of truth: all 10 languages with code, name, flag, voice config, RTL flag                                        |
| `platform/translation/index.ts`            | Barrel exports                                                                                                                |
| `platform/providers/registry.ts`           | `TRANSLATION_PROVIDER` slot added                                                                                             |
| Translation caching                        | Route through `AICache` — same (text + targetLang) = cache hit. Estimated 40-60% hit rate for common phrases.                 |
| Observability                              | `MetricsSink` events: `translation.latency`, `translation.cost`, `translation.cache_hit`                                      |
| Tests                                      | Unit + integration                                                                                                            |

**Limitation — 3 → 10 language expansion:**
Google Translate supports all 10 languages already. The limitation was hardcoded configs, not API capability. Sprint 1 removes this limitation by centralizing language definitions.

---

### Sprint 2: Voice Provider Abstraction + TTS Fix

**GenAI Principle Mapping:**

| Principle                    | Application                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| P1 — Orchestration only      | All TTS/STT through providers                                     |
| P2 — Every call instrumented | Audio duration, latency, cost per call                            |
| P7 — Provider abstraction    | `TTSProvider`, `STTProvider` interfaces                           |
| P11 — Graceful degradation   | Chunker handles oversized text; partial audio returned on failure |

**Deliverables:**

| File                             | Description                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `platform/voice/types.ts`        | `TTSProvider`: `synthesize(text, lang, options)` → audio. `STTProvider`: `transcribe(audio, lang)` → text. |
| `platform/voice/google-tts.ts`   | Google Cloud TTS implementation with automatic chunking                                                    |
| `platform/voice/google-stt.ts`   | Google Cloud STT implementation (server-side, not browser)                                                 |
| `platform/voice/mock-voice.ts`   | Mock for tests                                                                                             |
| `platform/voice/chunker.ts`      | TASK-020 fix: split text on sentence boundaries, respect 5,000-byte Google limit, reassemble audio         |
| `platform/voice/languages.ts`    | Voice configs for all 10 languages (Neural2 voices where available, Standard fallback)                     |
| `platform/providers/registry.ts` | `TTS_PROVIDER`, `STT_PROVIDER` slots                                                                       |
| Observability                    | `voice.tts.latency`, `voice.tts.audio_duration_ms`, `voice.tts.chunks`, `voice.stt.latency`                |
| Tests                            | Unit + integration, chunker edge cases (empty, single sentence, exactly 5000 bytes, Unicode)               |

**Limitation — Browser STT vs Server STT:**
Phase 3 builds server-side STT (Google Cloud Speech-to-Text) alongside the existing browser Web Speech API. Browser STT remains the default for live/continuous mode (zero latency, no API cost). Server STT is used for the Identify pipeline and future cases where browser API is unavailable (Safari inconsistencies, server-side processing).

**Future plan:** Phase 5+ evaluates Whisper or Deepgram as alternative STT providers. Provider swap = env var change.

---

### Sprint 3: Voice Pipeline + Tracing

**GenAI Principle Mapping:**

| Principle                    | Application                                                 |
| ---------------------------- | ----------------------------------------------------------- |
| P2 — Every call instrumented | Single traceId across entire STT → translate → TTS chain    |
| P9 — Observable              | End-to-end pipeline tracing with per-step latency breakdown |
| P11 — Graceful degradation   | Partial results on mid-pipeline failure                     |
| P3 — Safety at every I/O     | Translation input screened through safety pipeline          |

**Deliverables:**

| File                                              | Description                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/voice/pipeline.ts`                      | End-to-end orchestrator: STT → safety screen → translate → TTS                                                                            |
| Pipeline tracing                                  | One traceId, child spans: `stt.transcribe`, `safety.screen`, `translate.execute`, `tts.synthesize`                                        |
| Partial failure handling                          | STT succeeds + translate fails → return transcription with error. Translate succeeds + TTS fails → return text translation without audio. |
| Streaming TTS                                     | For long text: stream audio chunks as generated rather than buffering entire response                                                     |
| Health probes                                     | `TranslationHealthProbe`, `TTSHealthProbe` registered in HealthRegistry                                                                   |
| `docs/adr/ADR-019-voice-pipeline-architecture.md` | Multi-API chain design, provider abstraction, latency SLAs, failure modes                                                                 |
| Tests                                             | Pipeline integration tests (happy path, each failure mode, partial results)                                                               |

**Latency SLAs:**

| Operation                               | Target     | Measurement     |
| --------------------------------------- | ---------- | --------------- |
| Translation (single phrase, <100 chars) | <500ms     | 95th percentile |
| TTS (single chunk, <5000 bytes)         | <1 second  | 95th percentile |
| Full pipeline (STT → translate → TTS)   | <3 seconds | 95th percentile |
| Translation cache hit                   | <10ms      | 95th percentile |

---

### Sprint 4: Song Identification + Phase Gate

**GenAI Principle Mapping:**

| Principle                    | Application                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| P7 — Provider abstraction    | `SongIdentificationProvider` interface — ACRCloud first, swap to AudD.io via env var |
| P2 — Every call instrumented | Latency, success rate, confidence score                                              |
| P13 — Rate limiting          | 10 identifications per user per hour                                                 |

**Deliverables:**

| File                                  | Description                                                     |
| ------------------------------------- | --------------------------------------------------------------- |
| `platform/voice/identify-types.ts`    | `SongIdentificationProvider` interface, `SongMatch` result type |
| `platform/voice/acrcloud-identify.ts` | ACRCloud implementation                                         |
| `platform/voice/mock-identify.ts`     | Mock for tests                                                  |
| `platform/voice/audio-format.ts`      | Audio format conversion: WebM/Opus → WAV (required by ACRCloud) |
| `app/api/identify/route.ts`           | API endpoint for song identification                            |
| Rate limiting                         | 10 requests/user/hour via existing rate limiter                 |
| Playform wiring                       | Connect Identify mode to real backend                           |
| k6 load test                          | Translation + TTS concurrent load (10/50/100 users)             |
| Accessibility gate A1-A8              | On any new/modified UI                                          |
| RAMPS Phase 3 Assessment              | All 5 pillars                                                   |
| Phase exit gate E1-E15                | Full checklist                                                  |
| Tag v1.4.0                            | GitHub Release                                                  |

---

## Song Identification: Risks, Costs & Limitations

### API Provider Selection

**Decision:** ACRCloud (primary), with provider abstraction enabling swap to AudD.io.

**Why ACRCloud over AudD.io:**

- Higher recognition accuracy on partial/noisy audio
- Better music database coverage (major + indie labels)
- More established in production deployments
- Acceptable free tier for development

### Costs

| Tier           | Requests        | Cost            | Use Case                             |
| -------------- | --------------- | --------------- | ------------------------------------ |
| ACRCloud Free  | 100/day         | $0              | Development + testing                |
| ACRCloud Basic | 3,000/day       | ~$30/month      | Demo + early users                   |
| ACRCloud Pro   | 30,000/day      | ~$100/month     | Growth                               |
| AudD.io        | Pay-per-request | ~$0.01-0.02/req | Alternative if ACRCloud terms change |

**Budget:** $30/month during dev/demo phase. Review at Phase 5 based on actual usage.

### Limitations & Rationale

**1. Response limited to title + artist + album**

_Why:_ Lyrics require separate licensing (LyricFind, Musixmatch — $500+/month minimum). Streaming links (Spotify, Apple Music) require partner API agreements and compliance with each platform's terms. Album art may be copyrighted.

_Future plan (Phase 8+):_ Evaluate lyrics API licensing costs. Add Spotify/Apple Music deep links if partnership terms are favorable. Display album art under fair use for identification purposes.

**2. Rate limited to 10 identifications per user per hour**

_Why:_ Each identification sends 5-10 seconds of audio to ACRCloud — there's no caching possible (every audio clip is unique). At $0.01/request on paid tier, an unrestricted user could generate $1.44/day in API costs alone. Rate limiting protects against both cost overruns and API quota exhaustion.

_Future plan:_ Adjust limits based on user tier (free: 10/hour, subscriber: 30/hour, lifetime: unlimited). Tracked via entitlements system built in Phase 1.

**3. Audio format conversion required (WebM → WAV)**

_Why:_ Browser `MediaRecorder` outputs WebM/Opus by default. ACRCloud's recognition engine requires WAV, MP3, or raw PCM. Server-side conversion adds ~200ms latency and requires an audio processing dependency.

_Implementation:_ Lightweight server-side conversion using Web Audio API or a minimal ffmpeg wrapper. No heavy native dependencies.

_Future plan:_ If latency is unacceptable, explore client-side WAV recording (MediaRecorder with `audio/wav` MIME type — limited browser support) or ACRCloud's JavaScript SDK which handles format internally.

**4. Requires 5-10 seconds of clean audio**

_Why:_ Audio fingerprinting matches spectral patterns against a database. Short clips (<3 seconds) or heavy background noise produce low-confidence matches or false negatives. This is a fundamental limitation of the technology, not our implementation.

_UX mitigation:_ UI shows "Listening..." with a progress indicator and a tip: "Hold your device close to the speaker." If no match after 10 seconds, show: "Couldn't identify this song. Try with a clearer audio source." Never show a loading spinner with no feedback.

_Future plan:_ Evaluate Shazam's API (higher accuracy on short clips, but Apple ecosystem lock-in and higher cost). Provider abstraction makes this a swap.

**5. Privacy: raw audio sent to third-party API**

_Why:_ Audio fingerprinting requires sending actual audio data. Unlike text (which can be hashed or anonymized), audio must be sent as-is for recognition.

_Mitigation:_

- Explicit UI consent moment before recording ("Listening to identify song...")
- Audio is not stored on our servers — streamed directly to ACRCloud and discarded
- Privacy policy updated to disclose third-party audio processing
- COPPA: if user is under 13, song identification requires parental consent (enforced via age gate already in place)
- No voice/speech in the audio is processed — ACRCloud extracts only music fingerprints

_Future plan:_ Evaluate on-device fingerprinting (Chromaprint/AcoustID — open source, no data leaves device). Requires more Sprint time but eliminates privacy concern entirely. Phase 5+ consideration.

---

## Estimated Scope

| Metric             | Target                                |
| ------------------ | ------------------------------------- |
| New files          | ~20-25                                |
| New lines          | ~2,000-2,500                          |
| New tests          | 80-100                                |
| New ADR            | ADR-019 (Voice Pipeline Architecture) |
| Coverage target    | ≥83% (must not decrease from 82.54%)  |
| New provider slots | 4 (translation, TTS, STT, song ID)    |
| PF release         | v1.4.0                                |

---

## Dependencies

| Dependency                  | Required By | Status                                 |
| --------------------------- | ----------- | -------------------------------------- |
| Google Translate API key    | Sprint 1    | ✅ Already configured                  |
| Google Cloud TTS API key    | Sprint 2    | ✅ Already configured                  |
| Google Cloud STT API        | Sprint 2    | Needs enabling in Google Cloud Console |
| ACRCloud account + API key  | Sprint 4    | Needs signup ($0 for free tier)        |
| Audio format conversion lib | Sprint 4    | Evaluate at Sprint 4 start             |

---

## Cross-Phase Fabric Checklist

| Fabric         | Phase 3 Commitment                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Observability  | Per-call metrics + pipeline tracing for every translation, TTS, STT, and song ID call             |
| GenAI-Native   | All calls through provider abstraction + orchestration. Never direct API calls.                   |
| Content Safety | Translation input screened through safety pipeline before sending to Google                       |
| Agentic-Native | Provider interfaces support `onBehalfOf` for future agent delegation                              |
| Accessibility  | A1-A8 gate on every sprint. Any new voice UI has aria-labels, loading states, error announcements |

---

_Planned by: Raman Sud, CTO_
_Date: April 13, 2026_
