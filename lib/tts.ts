import { logger, generateRequestId } from "@/lib/logger";
import { sanitizeLanguageCode } from "@/lib/sanitize";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

const VOICE_CONFIG: Record<string, { languageCode: string; name: string }> = {
  en: { languageCode: "en-US", name: "en-US-Neural2-F" },
  hi: { languageCode: "hi-IN", name: "hi-IN-Neural2-A" },
  es: { languageCode: "es-ES", name: "es-ES-Neural2-A" },
};

function getApiKey(): string {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not configured");
  return key;
}

export async function textToSpeech(text: string, languageCode: string): Promise<string> {
  const requestId = generateRequestId();
  const safeLang = sanitizeLanguageCode(languageCode);
  const voice = VOICE_CONFIG[safeLang] || VOICE_CONFIG["en"];

  logger.debug("textToSpeech called", { requestId, route: "lib/tts" });

  const res = await fetchWithTimeout(TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // OWASP A02: API key in header, never in URL query parameter
      "X-Goog-Api-Key": getApiKey(),
    },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voice.languageCode, name: voice.name },
      audioConfig: { audioEncoding: "MP3", speakingRate: 0.95, pitch: 0 },
    }),
  });

  if (!res.ok) {
    logger.error("Google TTS API failed", {
      requestId,
      status: res.status,
      route: "lib/tts",
    });
    throw new Error(`Google TTS API error: ${res.status}`);
  }

  const data = await res.json();
  return data.audioContent as string;
}
