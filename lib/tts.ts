import axios from "axios";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

const VOICE_CONFIG: Record<string, { languageCode: string; name: string }> = {
  en: { languageCode: "en-US", name: "en-US-Neural2-F" },
  hi: { languageCode: "hi-IN", name: "hi-IN-Neural2-A" },
  es: { languageCode: "es-ES", name: "es-ES-Neural2-A" },
};

export async function textToSpeech(text: string, languageCode: string): Promise<string> {
  const voice = VOICE_CONFIG[languageCode] || VOICE_CONFIG["en"];
  const response = await axios.post(`${TTS_URL}?key=${GOOGLE_API_KEY}`, {
    input: { text },
    voice: {
      languageCode: voice.languageCode,
      name: voice.name,
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: 0.95,
      pitch: 0,
    },
  });
  return response.data.audioContent;
}
