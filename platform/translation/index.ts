/**
 * platform/translation/index.ts — Public API
 *
 * @module platform/translation
 */

// Types
export type {
  TranslationProvider,
  TranslationResult,
  DetectionResult,
  FanOutTranslation,
  TranslationMetrics,
  LanguageDefinition,
} from "./types";

// Languages — single source of truth
export {
  LANGUAGES,
  SUPPORTED_CODES,
  BASELINE_CODES,
  RTL_CODES,
  DEFAULT_OUTPUT_MAP,
  getLanguage,
  isSupported,
  isRTL,
  getDefaultOutputLanguage,
} from "./languages";

// Providers
export { GoogleTranslateProvider } from "./google-translate";
export { MockTranslateProvider } from "./mock-translate";
