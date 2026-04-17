/**
 * platform/voice/google-stt.ts — Google Cloud Speech-to-Text provider
 *
 * GenAI Principles:
 *   P1  — STT through provider interface, not raw fetch
 *   P2  — Every call instrumented (latency, confidence, language)
 *   P7  — Swappable: set STT_PROVIDER=google
 *
 * Supports auto-detect with multi-language pool (top 6 languages).
 * Normalizes language codes (e.g., zh-CN → zh).
 *
 * @module platform/voice
 */

import type { STTProvider, STTRequest, STTResult, AudioEncoding } from "./types";
import { AUTO_DETECT_POOL, VOICE_SUPPORTED_CODES } from "./voices";
import { logger, generateRequestId } from "@/lib/logger";
import { sanitizeLanguageCode } from "@/lib/sanitize";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { getGoogleApiKey } from "@/shared/config/apiKeys";

const STT_URL = "https://speech.googleapis.com/v1/speech:recognize";

const SUPPORTED_ENCODINGS: AudioEncoding[] = [
  "WEBM_OPUS",
  "OGG_OPUS",
  "MP3",
  "WAV",
  "FLAC",
  "LINEAR16",
];

export class GoogleSTTProvider implements STTProvider {
  readonly name = "google";

  async transcribe(request: STTRequest): Promise<STTResult> {
    const requestId = generateRequestId();
    const start = Date.now();
    const encoding = request.encoding ?? "WEBM_OPUS";
    const sampleRate = request.sampleRateHertz ?? this.getDefaultSampleRate(encoding);
    const languageCode = request.languageCode
      ? sanitizeLanguageCode(request.languageCode)
      : "en-US";
    const autoDetect = request.autoDetect ?? false;

    logger.debug("GoogleSTT.transcribe", {
      requestId,
      encoding,
      sampleRate,
      autoDetect,
      route: "platform/voice",
    });

    const config: Record<string, unknown> = {
      encoding,
      sampleRateHertz: sampleRate,
      languageCode: autoDetect ? "en-US" : languageCode,
      enableAutomaticPunctuation: true,
      model: "latest_long",
      useEnhanced: true,
    };

    if (autoDetect) {
      config.alternativeLanguageCodes = AUTO_DETECT_POOL.filter((l) => l !== "en-US");
    }

    const res = await fetchWithTimeout(STT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getGoogleApiKey(),
      },
      body: JSON.stringify({
        config,
        audio: { content: request.audioBase64 },
      }),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      logger.error("GoogleSTT.transcribe failed", {
        requestId,
        status: res.status,
        latencyMs,
        route: "platform/voice",
      });
      throw new Error(`Google STT API error: ${res.status}`);
    }

    const response = await res.json();
    const results = response.results;

    if (!results || results.length === 0) {
      return {
        transcript: "",
        confidence: 0,
        languageCode,
        latencyMs,
      };
    }

    const best = results[0].alternatives[0];
    const detectedLang = results[0].languageCode ?? (autoDetect ? "en-US" : languageCode);

    // Normalize language codes (zh-CN → zh for our system)
    const normalized = this.normalizeLanguageCode(detectedLang);

    return {
      transcript: best.transcript ?? "",
      confidence: best.confidence ?? 0,
      languageCode: normalized,
      latencyMs,
    };
  }

  getSupportedLanguages(): string[] {
    return [...VOICE_SUPPORTED_CODES];
  }

  getSupportedEncodings(): AudioEncoding[] {
    return [...SUPPORTED_ENCODINGS];
  }

  // ── Private ─────────────────────────────────────────────────────────

  private getDefaultSampleRate(encoding: AudioEncoding): number {
    switch (encoding) {
      case "WAV":
      case "LINEAR16":
      case "FLAC":
        return 44100;
      default:
        return 48000; // WEBM_OPUS, OGG_OPUS, MP3
    }
  }

  private normalizeLanguageCode(code: string): string {
    // Google returns codes like "en-us", "zh-cn", "cmn-cn"
    if (code.startsWith("zh") || code.startsWith("cmn")) return "zh";
    // Return the base language code (before hyphen) for our system
    const base = code.split("-")[0].toLowerCase();
    return base;
  }
}
