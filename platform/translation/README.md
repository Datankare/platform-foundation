# translation

Provider-abstracted translation with language detection, fan-out, and caching.

## Status

✅ **Sprint 1 Complete** — TranslationProvider interface, Google + Mock implementations, 10-language registry.

## Architecture

```
platform/translation/
  ├── types.ts              — TranslationProvider interface, result types, metrics
  ├── languages.ts          — Single source of truth: 10 languages with metadata
  ├── google-translate.ts   — Google Translate v2 implementation
  ├── mock-translate.ts     — Deterministic mock (tests + local dev)
  └── index.ts              — Public API barrel exports
```

## Provider Selection

```
TRANSLATION_PROVIDER = "google" | "mock"   (default: "mock")
```

Zero env vars = mock provider = working demo with no external dependencies or cost.

## Languages

| Code | Language  | Flag | RTL | Baseline |
| ---- | --------- | ---- | --- | -------- |
| en   | English   | 🇺🇸   | No  | Yes      |
| es   | Spanish   | 🇪🇸   | No  | Yes      |
| fr   | French    | 🇫🇷   | No  | Yes      |
| hi   | Hindi     | 🇮🇳   | No  | No       |
| ar   | Arabic    | 🇸🇦   | Yes | No       |
| zh   | Chinese   | 🇨🇳   | No  | No       |
| bn   | Bengali   | 🇮🇳   | No  | No       |
| kn   | Kannada   | 🇮🇳   | No  | No       |
| ml   | Malayalam | 🇮🇳   | No  | No       |
| te   | Telugu    | 🇮🇳   | No  | No       |

Baseline languages are always included in fan-out translations. Non-baseline languages are user-selectable.

## Usage

```typescript
import { GoogleTranslateProvider, MockTranslateProvider } from "@/platform/translation";
import { LANGUAGES, getDefaultOutputLanguage } from "@/platform/translation";

// Create provider
const provider = new GoogleTranslateProvider(); // or MockTranslateProvider

// Translate
const result = await provider.translate("Hello", "es");
// { text: "Hola", sourceLanguage: "en", targetLanguage: "es", latencyMs: 150, cached: false }

// Detect language
const detected = await provider.detectLanguage("Bonjour");
// { language: "fr", confidence: 0.98, latencyMs: 80 }

// Get default output for input language
const output = getDefaultOutputLanguage("hi", ["en", "es"]);
// "en"
```

## Adding a New Provider

1. Create `platform/translation/{provider}-translate.ts` implementing `TranslationProvider`
2. Register in `platform/providers/registry.ts` (add `TranslationProviderType` variant)
3. Set `TRANSLATION_PROVIDER={provider}`
4. Add tests

---

_See [PHASE3_PLAN.md](../../docs/PHASE3_PLAN.md) for the full sprint plan._
