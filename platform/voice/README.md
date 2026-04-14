# voice

Provider-abstracted voice: text-to-speech, speech-to-text, and audio processing.

## Status

✅ **Sprint 2 Complete** — TTSProvider + STTProvider interfaces, Google + Mock implementations, text chunker (TASK-020).

## Architecture

```
platform/voice/
  ├── types.ts          — TTSProvider, STTProvider interfaces, request/result types
  ├── voices.ts         — Voice configs for all 10 languages (TTS + STT codes)
  ├── chunker.ts        — TASK-020: text chunker for 5,000-byte TTS limit
  ├── google-tts.ts     — Google Cloud TTS with automatic chunking
  ├── google-stt.ts     — Google Cloud STT with multi-language auto-detect
  ├── mock-voice.ts     — Mock TTS + STT for tests (zero cost)
  └── index.ts          — Public API barrel exports
```

## Provider Selection

```
TTS_PROVIDER = "google" | "mock"   (default: "mock")
STT_PROVIDER = "google" | "mock"   (default: "mock")
```

## TASK-020: TTS Chunking

Google Cloud TTS has a 5,000-byte limit per request. The chunker automatically:

1. Splits on sentence boundaries (`.` `!` `?`)
2. Falls back to clause boundaries (`,` `;` `:`)
3. Hard-splits at byte boundary as last resort
4. Concatenates audio from all chunks

Multi-byte characters (Hindi, Chinese, Arabic) are handled correctly via UTF-8 byte counting.

## Voice Configs (10 languages)

| Code | Language  | TTS Voice        | STT Code |
| ---- | --------- | ---------------- | -------- |
| en   | English   | en-US-Neural2-F  | en-US    |
| es   | Spanish   | es-ES-Neural2-A  | es-ES    |
| fr   | French    | fr-FR-Neural2-F  | fr-FR    |
| hi   | Hindi     | hi-IN-Neural2-A  | hi-IN    |
| ar   | Arabic    | ar-XA-Wavenet-A  | ar-XA    |
| zh   | Chinese   | cmn-CN-Wavenet-A | cmn-CN   |
| bn   | Bengali   | bn-IN-Wavenet-A  | bn-IN    |
| kn   | Kannada   | kn-IN-Wavenet-A  | kn-IN    |
| ml   | Malayalam | ml-IN-Wavenet-A  | ml-IN    |
| te   | Telugu    | te-IN-Standard-A | te-IN    |

## Adding a New Provider

1. Create `platform/voice/{provider}-tts.ts` implementing `TTSProvider`
2. Create `platform/voice/{provider}-stt.ts` implementing `STTProvider`
3. Register in `platform/providers/registry.ts`
4. Set `TTS_PROVIDER={provider}` and/or `STT_PROVIDER={provider}`
5. Add tests

---

_See [PHASE3_PLAN.md](../../docs/PHASE3_PLAN.md) for the full sprint plan._
