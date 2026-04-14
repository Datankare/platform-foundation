/**
 * platform/voice/google-tts.ts — Google Cloud TTS provider
 *
 * GenAI Principles:
 *   P1  — TTS through provider interface, not raw fetch
 *   P2  — Every call instrumented (latency, chunks, text bytes)
 *   P7  — Swappable: set TTS_PROVIDER=google
 *   P11 — Graceful degradation: auto-chunks text over 5000 bytes
 *
 * TASK-020: Handles 5,000-byte limit via automatic chunking.
 * Long text is split on sentence boundaries, each chunk synthesized
 * separately, and audio concatenated (base64).
 *
 * @module platform/voice
 */

import type { TTSProvider, TTSRequest, TTSResult, AudioEncoding } from "./types";
import { getVoiceConfig, VOICE_SUPPORTED_CODES } from "./voices";
import { chunkText, getByteLength } from "./chunker";
import { logger, generateRequestId } from "@/lib/logger";
import { sanitizeLanguageCode } from "@/lib/sanitize";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { getGoogleApiKey } from "@/shared/config/apiKeys";

const TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";

export class GoogleTTSProvider implements TTSProvider {
  readonly name = "google";

  async synthesize(request: TTSRequest): Promise<TTSResult> {
    const requestId = generateRequestId();
    const safeLang = sanitizeLanguageCode(request.languageCode);
    const voice = getVoiceConfig(safeLang);
    const encoding = request.encoding ?? "MP3";
    const start = Date.now();
    const textBytes = getByteLength(request.text);

    logger.debug("GoogleTTS.synthesize", {
      requestId,
      languageCode: safeLang,
      textBytes,
      route: "platform/voice",
    });

    // Chunk text if it exceeds the limit
    const chunks = chunkText(request.text);

    if (chunks.length === 0) {
      return {
        audioContent: "",
        encoding,
        languageCode: safeLang,
        chunks: 0,
        latencyMs: Date.now() - start,
        textBytes: 0,
      };
    }

    // Synthesize each chunk
    const audioChunks: string[] = [];

    for (const chunk of chunks) {
      const audio = await this.synthesizeChunk(
        chunk,
        voice.languageCode,
        voice.voiceName,
        encoding,
        request.speakingRate ?? 0.95,
        request.pitch ?? 0,
        requestId
      );
      audioChunks.push(audio);
    }

    // Concatenate base64 audio
    const audioContent =
      audioChunks.length === 1
        ? audioChunks[0]
        : this.concatenateBase64Audio(audioChunks);

    const latencyMs = Date.now() - start;

    logger.debug("GoogleTTS.synthesize complete", {
      requestId,
      chunks: chunks.length,
      latencyMs,
      route: "platform/voice",
    });

    return {
      audioContent,
      encoding,
      languageCode: safeLang,
      chunks: chunks.length,
      latencyMs,
      textBytes,
    };
  }

  getSupportedLanguages(): string[] {
    return [...VOICE_SUPPORTED_CODES];
  }

  // ── Private ─────────────────────────────────────────────────────────

  private async synthesizeChunk(
    text: string,
    languageCode: string,
    voiceName: string,
    encoding: AudioEncoding,
    speakingRate: number,
    pitch: number,
    requestId: string
  ): Promise<string> {
    const res = await fetchWithTimeout(TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getGoogleApiKey(),
      },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceName },
        audioConfig: { audioEncoding: encoding, speakingRate, pitch },
      }),
    });

    if (!res.ok) {
      logger.error("GoogleTTS.synthesizeChunk failed", {
        requestId,
        status: res.status,
        route: "platform/voice",
      });
      throw new Error(`Google TTS API error: ${res.status}`);
    }

    const data = await res.json();
    return data.audioContent as string;
  }

  /**
   * Concatenate multiple base64-encoded MP3 chunks.
   * Decodes each to binary, concatenates, re-encodes to base64.
   */
  private concatenateBase64Audio(chunks: string[]): string {
    // In Node.js, Buffer handles base64 natively
    const buffers = chunks.map((c) => Buffer.from(c, "base64"));
    const combined = Buffer.concat(buffers);
    return combined.toString("base64");
  }
}
