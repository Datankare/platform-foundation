/**
 * platform/translation/google-translate.ts — Google Translate v2 provider
 *
 * GenAI Principles:
 *   P1  — Translation through provider interface, not raw fetch
 *   P2  — Every call instrumented (latency, language pair, text length)
 *   P7  — Swappable: set TRANSLATION_PROVIDER=google
 *   P9  — Observable: returns latencyMs in every result
 *
 * Wraps the Google Cloud Translation v2 REST API.
 * API key via X-Goog-Api-Key header (OWASP A02 — never in URL params).
 *
 * @module platform/translation
 */

import type { TranslationProvider, TranslationResult, DetectionResult } from "./types";
import { SUPPORTED_CODES } from "./languages";
import { logger, generateRequestId } from "@/lib/logger";
import { sanitizeLanguageCode } from "@/lib/sanitize";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { getGoogleApiKey } from "@/shared/config/apiKeys";

const TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";
const DETECT_URL = "https://translation.googleapis.com/language/translate/v2/detect";

// ── Provider Implementation ─────────────────────────────────────────────

export class GoogleTranslateProvider implements TranslationProvider {
  readonly name = "google";

  async translate(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string
  ): Promise<TranslationResult> {
    const requestId = generateRequestId();
    const safeLang = sanitizeLanguageCode(targetLanguage);
    const start = Date.now();

    logger.debug("GoogleTranslate.translate", {
      requestId,
      targetLanguage: safeLang,
      textLength: text.length,
      route: "platform/translation",
    });

    const body: Record<string, string> = {
      q: text,
      target: safeLang,
      format: "text",
    };
    if (sourceLanguage) {
      body.source = sanitizeLanguageCode(sourceLanguage);
    }

    const res = await fetchWithTimeout(TRANSLATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getGoogleApiKey(),
      },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      logger.error("GoogleTranslate.translate failed", {
        requestId,
        status: res.status,
        latencyMs,
        route: "platform/translation",
      });
      throw new Error(`Google Translate API error: ${res.status}`);
    }

    const data = await res.json();
    const translatedText = data.data.translations[0].translatedText as string;
    const detectedSource =
      sourceLanguage ||
      (data.data.translations[0].detectedSourceLanguage as string) ||
      "unknown";

    return {
      text: translatedText,
      sourceLanguage: detectedSource.startsWith("zh") ? "zh" : detectedSource,
      targetLanguage: safeLang,
      latencyMs,
      cached: false,
    };
  }

  async detectLanguage(text: string): Promise<DetectionResult> {
    const requestId = generateRequestId();
    const start = Date.now();

    logger.debug("GoogleTranslate.detectLanguage", {
      requestId,
      textLength: text.length,
      route: "platform/translation",
    });

    const res = await fetchWithTimeout(DETECT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getGoogleApiKey(),
      },
      body: JSON.stringify({ q: text }),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      logger.error("GoogleTranslate.detectLanguage failed", {
        requestId,
        status: res.status,
        latencyMs,
        route: "platform/translation",
      });
      throw new Error(`Google Detect API error: ${res.status}`);
    }

    const data = await res.json();
    const detection = data.data.detections[0][0];
    const detected = (detection.language as string).startsWith("zh")
      ? "zh"
      : (detection.language as string);

    return {
      language: detected,
      confidence: (detection.confidence as number) || 1.0,
      latencyMs,
    };
  }

  getSupportedLanguages(): string[] {
    return [...SUPPORTED_CODES];
  }
}
