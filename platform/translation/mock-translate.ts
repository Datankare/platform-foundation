/**
 * platform/translation/mock-translate.ts — Mock translation provider
 *
 * Deterministic results for tests. Zero API cost.
 * Returns predictable translations: "[MOCK:{lang}] {text}"
 *
 * @module platform/translation
 */

import type { TranslationProvider, TranslationResult, DetectionResult } from "./types";
import { SUPPORTED_CODES } from "./languages";

export class MockTranslateProvider implements TranslationProvider {
  readonly name = "mock";

  private _callCount = 0;
  private _detectCount = 0;

  /** Number of translate() calls made */
  get callCount(): number {
    return this._callCount;
  }

  /** Number of detectLanguage() calls made */
  get detectCount(): number {
    return this._detectCount;
  }

  /** Reset counters */
  reset(): void {
    this._callCount = 0;
    this._detectCount = 0;
  }

  async translate(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string
  ): Promise<TranslationResult> {
    this._callCount++;

    return {
      text: `[MOCK:${targetLanguage}] ${text}`,
      sourceLanguage: sourceLanguage || "en",
      targetLanguage,
      latencyMs: 1,
      cached: false,
    };
  }

  async detectLanguage(text: string): Promise<DetectionResult> {
    this._detectCount++;

    // Simple heuristic for testing: check first character Unicode range
    const firstChar = text.codePointAt(0) || 0;

    let language = "en";
    if (firstChar >= 0x0900 && firstChar <= 0x097f) language = "hi";
    if (firstChar >= 0x0600 && firstChar <= 0x06ff) language = "ar";
    if (firstChar >= 0x4e00 && firstChar <= 0x9fff) language = "zh";
    if (firstChar >= 0x00c0 && firstChar <= 0x024f) language = "fr";

    return {
      language,
      confidence: 0.95,
      latencyMs: 1,
    };
  }

  getSupportedLanguages(): string[] {
    return [...SUPPORTED_CODES];
  }
}
