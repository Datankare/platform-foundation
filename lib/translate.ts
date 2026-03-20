import axios from "axios";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
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
  const response = await axios.post(`${TRANSLATE_URL}?key=${GOOGLE_API_KEY}`, {
    q: text,
    target: targetLanguage,
    format: "text",
  });
  return response.data.data.translations[0].translatedText;
}

export async function translateToAllLanguages(
  text: string
): Promise<{ code: string; language: string; flag: string; translated: string }[]> {
  const results = await Promise.all(
    TARGET_LANGUAGES.map(async (lang) => {
      const translated = await translateText(text, lang.code);
      return {
        code: lang.code,
        language: lang.language,
        flag: lang.flag,
        translated,
      };
    })
  );
  return results;
}
