# platform/voice — Voice, Song Identification and Audio Conversion

Three product modules share this directory until Sprint 7S moves them apart (ADR-054 D2). Each has
its own public entry and definition, and its own files listed in `platform/modules/manifest.json`;
the lint boundary allows each to import only the modules it declares.

| Module          | Public entry       | Definition                | Depends on                 | Contents                                                      |
| --------------- | ------------------ | ------------------------- | -------------------------- | ------------------------------------------------------------- |
| `voice`         | `index.ts`         | `voice-module.ts`         | translation, audio-convert | TTS, STT, the voice pipeline, chunker, voices, their probes   |
| `song-id`       | `song-id.ts`       | `song-id-module.ts`       | audio-convert              | Song identification providers, the active provider, its probe |
| `audio-convert` | `audio-convert.ts` | `audio-convert-module.ts` | —                          | Canonical format, converters, readiness, probe                |

Import a module through its entry: `@/platform/voice` (voice), `@/platform/voice/song-id`,
`@/platform/voice/audio-convert`. `@/platform/voice` no longer re-exports song identification or
audio conversion.

## Architecture

All operations flow through provider interfaces whose slots the modules declare (registered by the
app at boot — `platform/modules/app-modules.ts`; `platform/providers/registry.ts` installs them like
its own). No direct API calls — swap providers via environment variables. All external HTTP calls
use `fetchWithTimeout` from `@/lib/fetchWithTimeout`.

```
Browser Audio (WebM/Opus)
    │
    ▼
AudioFormatConverter ─── Canonical WAV (16kHz mono s16 PCM)
    │                         │
    ▼                         ▼
SongIdentificationProvider    VoicePipeline
(ACRCloud / mock)             (STT → Safety → Translate → TTS)
    │                         │
    ▼                         ▼
SongMatch | null              PipelineResult
```

## Canonical Audio Format

**All audio entering the platform is normalized to WAV 16kHz mono 16-bit PCM.**

This is a platform decision, not a provider decision. Benefits:

- Strips container metadata (privacy P3/P12)
- Consistent input to all downstream providers
- Removes device/software identifiers from audio containers

See `audio-format-types.ts` for the `CANONICAL_FORMAT` constant and `AudioFormatConverter` interface.

## Provider Slots (declared by the modules)

| Slot             | Module        | Env Var            | Options                             | Default |
| ---------------- | ------------- | ------------------ | ----------------------------------- | ------- |
| `tts`            | voice         | `TTS_PROVIDER`     | google / mock                       | mock    |
| `stt`            | voice         | `STT_PROVIDER`     | google / mock                       | mock    |
| `songId`         | song-id       | `SONG_ID_PROVIDER` | acrcloud / mock                     | mock    |
| `audioConverter` | audio-convert | `AUDIO_CONVERTER`  | ffmpeg-service / passthrough / mock | mock    |

## Module Files

### Core Types

| File                    | Description                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `types.ts`              | TTSProvider, STTProvider interfaces, VoiceConfig, VoiceMetrics                                          |
| `audio-format-types.ts` | AudioFormatConverter interface, CANONICAL_FORMAT, ConversionRequest/Result (with P5 `estimatedCostUsd`) |
| `identify-types.ts`     | SongIdentificationProvider, SongMatch, IdentifyRequest/Result (with P5/P16/P17/P18), IdentifyCache      |

### Provider Implementations

| File                       | Provider         | Key detail                                              |
| -------------------------- | ---------------- | ------------------------------------------------------- |
| `google-tts.ts`            | Google Cloud TTS | Neural2/Wavenet voices, auto-chunking                   |
| `google-stt.ts`            | Google Cloud STT | Server-side transcription, 10-language pool             |
| `ffmpeg-converter.ts`      | FFmpeg service   | `fetchWithTimeout` to `AUDIO_CONVERTER_URL`             |
| `passthrough-converter.ts` | Passthrough      | WAV-only, no conversion (dev/optimization)              |
| `acrcloud-identify.ts`     | ACRCloud         | HMAC-SHA1 signed, `fetchWithTimeout`, extracted methods |

### Mocks (for testing)

| File                      | Description                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| `mock-voice.ts`           | MockTTSProvider, MockSTTProvider                                    |
| `mock-audio-converter.ts` | MockAudioConverter — all formats, call tracking, error injection    |
| `mock-identify.ts`        | MockSongIdentifier — configurable match/no-match, P5/P17/P18 fields |

### Orchestration

| File              | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `pipeline.ts`     | VoicePipeline: STT → safety → translate → TTS (P15-P18 agentic) |
| `chunker.ts`      | TTS text chunking (5,000-byte Google limit)                     |
| `voices.ts`       | Voice configs for 10 languages                                  |
| `health-probe.ts` | Health checks for translation, TTS, STT (voice)                 |

### Song identification (song-id)

| File                  | Description                                                                |
| --------------------- | -------------------------------------------------------------------------- |
| `song-id-provider.ts` | The active provider (`getSongIdProvider` / `setSongIdProvider`)            |
| `song-id-health.ts`   | `checkSongIdHealth`, `SongIdHealthProbeAdapter` (registered by the module) |

### Audio conversion (audio-convert)

| File                           | Description                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `audio-convert-health.ts`      | `checkAudioConverterHealth`                                               |
| `audio-converter-readiness.ts` | `isAudioConverterReady` — what music identification and audio upload need |

## Song Identification

### How It Works

1. Browser records audio via `MediaRecorder` (WebM/Opus)
2. `AudioFormatConverter` normalizes to canonical WAV (strips metadata)
3. `SongIdentificationProvider` sends 5-15s clip to ACRCloud
4. Returns `SongMatch` (title, artist, album, confidence) or `null`

### Privacy Controls

- Audio exists in memory only during request lifecycle
- Metadata stripped during canonical conversion (P3/P12)
- 15-second max clip enforced in provider
- Explicit user consent required (tap "Identify")
- Audit logs: who, when, result — **never** audio content
- ACRCloud receives only canonical WAV, no user/session/device info

### Rate Limiting (P13)

`SONG_IDENTIFY_RULE` (`identify-types.ts`, exported by `@/platform/voice/song-id`): 10 identifications per user per hour, registered by the song-id module (it was `DEFAULT_RULES.SONG_IDENTIFY` in the core until ADR-054). The consumer's identification route enforces it with `enforceRateLimit(request, SONG_IDENTIFY_RULE, { actorId })` (ADR-052).

### Cost Tracking (P5)

Every `IdentifyResult` includes `estimatedCostUsd` (~$0.01 on ACRCloud paid tier, $0 for mock).

### Agentic Support (P15-P18)

- P15: `actorType`/`actorId`/`onBehalfOf` on `IdentifyRequest`
- P16: `IdentifyCache` interface for fingerprint dedup
- P17: `IDENTIFY_INTENT = "inform"` constant in every result
- P18: `trajectoryId`/`stepIndex` passed through request → result

## Audio Format Conversion

### FFmpeg Service

Reached at `AUDIO_CONVERTER_URL`, authenticated with `AUDIO_CONVERTER_KEY`. The original ECS Fargate deployment was retired in 2026-10; its replacement is tracked in TASK-025.

```
POST /convert
Headers: X-Service-Key, X-Source-Format
Body: raw audio bytes
Response: canonical WAV (16kHz mono s16 PCM)
```

Environment variables: `AUDIO_CONVERTER_URL`, `AUDIO_CONVERTER_KEY`

### Passthrough Converter

Accepts only WAV input. Use for pre-converted audio or development without the ffmpeg service.

## Voice Pipeline

End-to-end chain with agentic context (P15-P18):

| Step      | Intent (P17) | Description                       |
| --------- | ------------ | --------------------------------- |
| STT       | inform       | Transcribe audio to text          |
| Safety    | checkpoint   | Screen content before translation |
| Translate | propose      | Translate to target language      |
| TTS       | commit       | Synthesize translated audio       |

See `pipeline.ts` and ADR-019 for full architecture.

## Health Probes

| Probe           | Function                      | Module        | Notes                      |
| --------------- | ----------------------------- | ------------- | -------------------------- |
| Translation     | `checkTranslationHealth()`    | voice         | Translates known phrase    |
| TTS             | `checkTTSHealth()`            | voice         | Synthesizes short phrase   |
| STT             | `checkSTTHealth()`            | voice         | Sends silent audio clip    |
| Song ID         | `checkSongIdHealth()`         | song-id       | Sends minimal audio buffer |
| Audio Converter | `checkAudioConverterHealth()` | audio-convert | Converts minimal WAV       |

All probes distinguish connectivity errors (unhealthy) from validation errors (healthy — provider is reachable) through the core's `probeResponsive` (`platform/observability/provider-health.ts`). The song-id module registers its probe for `/api/health` (`healthProbes` in its definition), cached for 15 minutes because each check is a billable identify call (audit X-13).

## ADRs

- **ADR-019** — Voice Pipeline Architecture
- **ADR-020** — Song Identification Architecture
- **ADR-054** — The foundation core and optional product modules

## GenAI Principles

All voice module code maps to the 18 GenAI principles documented in `GENAI_MANIFESTO.md`. Every sprint begins with a complete 18-principle mapping table verified before any code is written (L12).
