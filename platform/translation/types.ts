/**
 * platform/translation/types.ts — Translation provider contracts
 *
 * GenAI Principles:
 *   P1  — All translation through provider, never direct API
 *   P7  — Provider abstraction: swap Google → DeepL → mock via env var
 *   P9  — Observable: every method returns metadata for instrumentation
 *
 * @module platform/translation
 */

// ── Language Definition ─────────────────────────────────────────────────

export interface LanguageDefinition {
  /** ISO 639-1 code (e.g., "en", "es", "zh") */
  readonly code: string;
  /** Human-readable name (e.g., "English", "Spanish") */
  readonly language: string;
  /** Flag emoji */
  readonly flag: string;
  /** Whether this language is RTL */
  readonly rtl: boolean;
  /** Baseline language — always included in fan-out translations */
  readonly baseline: boolean;
}

// ── Translation Result ──────────────────────────────────────────────────

export interface TranslationResult {
  /** Translated text */
  readonly text: string;
  /** Source language (detected or provided) */
  readonly sourceLanguage: string;
  /** Target language */
  readonly targetLanguage: string;
  /** Translation latency in ms */
  readonly latencyMs: number;
  /** Whether result came from cache */
  readonly cached: boolean;
}

// ── Detection Result ────────────────────────────────────────────────────

export interface DetectionResult {
  /** Detected language code */
  readonly language: string;
  /** Detection confidence (0-1) */
  readonly confidence: number;
  /** Detection latency in ms */
  readonly latencyMs: number;
}

// ── Fan-Out Result (translate to multiple languages) ────────────────────

export interface FanOutTranslation {
  readonly code: string;
  readonly language: string;
  readonly flag: string;
  readonly translated: string;
  readonly latencyMs: number;
  readonly cached: boolean;
}

// ── Provider Interface ──────────────────────────────────────────────────

export interface TranslationProvider {
  /** Provider name (e.g., "google", "deepl", "mock") */
  readonly name: string;

  /**
   * Translate text from source to target language.
   * If sourceLanguage is omitted, auto-detect.
   */
  translate(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string
  ): Promise<TranslationResult>;

  /**
   * Detect the language of input text.
   */
  detectLanguage(text: string): Promise<DetectionResult>;

  /**
   * Get list of supported language codes.
   */
  getSupportedLanguages(): string[];
}

// ── Translation Metrics (for MetricsSink) ───────────────────────────────

export interface TranslationMetrics {
  readonly provider: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly textLength: number;
  readonly latencyMs: number;
  readonly cached: boolean;
  readonly success: boolean;
  readonly error?: string;
}
