import { logger, generateRequestId } from "@/lib/logger";
import { sanitizeLanguageCode } from "@/lib/sanitize";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { getGoogleApiKey } from "@/shared/config/apiKeys";

const TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";

export const TARGET_LANGUAGES = [
  { code: "en", language: "English", flag: "\u{1F1FA}\u{1F1F8}" },
  { code: "hi", language: "Hindi", flag: "\u{1F1EE}\u{1F1F3}" },
  { code: "es", language: "Spanish", flag: "\u{1F1EA}\u{1F1F8}" },
];

export async function translateText(
  text: string,
  targetLanguage: string
): Promise<string> {
  const requestId = generateRequestId();
  const safeLang = sanitizeLanguageCode(targetLanguage);

  const res = await fetchWithTimeout(TRANSLATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // OWASP A02: API key in header, never in URL query parameter
      "X-Goog-Api-Key": getGoogleApiKey(),
    },
    body: JSON.stringify({ q: text, target: safeLang, format: "text" }),
  });

  if (!res.ok) {
    logger.error("Google Translate API failed", {
      requestId,
      status: res.status,
      route: "lib/translate",
    });
    throw new Error(`Google Translate API error: ${res.status}`);
  }

  const data = await res.json();
  return data.data.translations[0].translatedText as string;
}

export async function translateToAllLanguages(
  text: string
): Promise<{ code: string; language: string; flag: string; translated: string }[]> {
  const results = await Promise.all(
    TARGET_LANGUAGES.map(async (lang) => {
      const translated = await translateText(text, lang.code);
      return { code: lang.code, language: lang.language, flag: lang.flag, translated };
    })
  );
  return results;
}
