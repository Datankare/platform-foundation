/**
 * platform/translation/languages.ts — Language registry
 *
 * Single source of truth for all supported languages.
 * Both PF and Playform consume this instead of hardcoding language arrays.
 *
 * @module platform/translation
 */

import type { LanguageDefinition } from "./types";

// ── Language Definitions ────────────────────────────────────────────────

export const LANGUAGES: readonly LanguageDefinition[] = [
  {
    code: "en",
    language: "English",
    flag: "\u{1F1FA}\u{1F1F8}",
    rtl: false,
    baseline: true,
  },
  {
    code: "es",
    language: "Spanish",
    flag: "\u{1F1EA}\u{1F1F8}",
    rtl: false,
    baseline: true,
  },
  {
    code: "fr",
    language: "French",
    flag: "\u{1F1EB}\u{1F1F7}",
    rtl: false,
    baseline: true,
  },
  {
    code: "hi",
    language: "Hindi",
    flag: "\u{1F1EE}\u{1F1F3}",
    rtl: false,
    baseline: false,
  },
  {
    code: "ar",
    language: "Arabic",
    flag: "\u{1F1F8}\u{1F1E6}",
    rtl: true,
    baseline: false,
  },
  {
    code: "zh",
    language: "Chinese",
    flag: "\u{1F1E8}\u{1F1F3}",
    rtl: false,
    baseline: false,
  },
  {
    code: "bn",
    language: "Bengali",
    flag: "\u{1F1EE}\u{1F1F3}",
    rtl: false,
    baseline: false,
  },
  {
    code: "kn",
    language: "Kannada",
    flag: "\u{1F1EE}\u{1F1F3}",
    rtl: false,
    baseline: false,
  },
  {
    code: "ml",
    language: "Malayalam",
    flag: "\u{1F1EE}\u{1F1F3}",
    rtl: false,
    baseline: false,
  },
  {
    code: "te",
    language: "Telugu",
    flag: "\u{1F1EE}\u{1F1F3}",
    rtl: false,
    baseline: false,
  },
] as const;

// ── Convenience Accessors ───────────────────────────────────────────────

/** All supported language codes */
export const SUPPORTED_CODES: readonly string[] = LANGUAGES.map((l) => l.code);

/** Baseline languages — always included in fan-out translations */
export const BASELINE_CODES: readonly string[] = LANGUAGES.filter((l) => l.baseline).map(
  (l) => l.code
);

/** RTL language codes */
export const RTL_CODES: readonly string[] = LANGUAGES.filter((l) => l.rtl).map(
  (l) => l.code
);

/** Lookup language by code */
export function getLanguage(code: string): LanguageDefinition | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

/** Check if a language code is supported */
export function isSupported(code: string): boolean {
  return SUPPORTED_CODES.includes(code);
}

/** Check if a language code is RTL */
export function isRTL(code: string): boolean {
  return RTL_CODES.includes(code);
}

/**
 * Default output language when input is in a given language.
 * Rule: if input is English, output Spanish. Otherwise, output English.
 */
export const DEFAULT_OUTPUT_MAP: Record<string, string> = Object.fromEntries(
  LANGUAGES.map((l) => [l.code, l.code === "en" ? "es" : "en"])
);

/**
 * Get the default output language for a given input language,
 * constrained to the user's selected languages.
 */
export function getDefaultOutputLanguage(
  inputLang: string,
  userLanguageCodes: string[]
): string {
  const defaultOutput = DEFAULT_OUTPUT_MAP[inputLang] || "en";
  if (userLanguageCodes.includes(defaultOutput)) return defaultOutput;
  return "en";
}
