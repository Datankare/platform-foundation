/**
 * platform/voice/mock-voice.ts — Mock TTS + STT providers
 *
 * Deterministic results for tests. Zero API cost.
 * TTS returns a predictable base64 string.
 * STT returns input-dependent transcription.
 *
 * @module platform/voice
 */

import type {
  TTSProvider,
  STTProvider,
  TTSRequest,
  TTSResult,
  STTRequest,
  STTResult,
  AudioEncoding,
} from "./types";
import { VOICE_SUPPORTED_CODES } from "./voices";
import { getByteLength, chunkText } from "./chunker";

// ── Mock TTS ────────────────────────────────────────────────────────────

export class MockTTSProvider implements TTSProvider {
  readonly name = "mock";

  private _callCount = 0;
  private _totalChunks = 0;

  get callCount(): number {
    return this._callCount;
  }

  get totalChunks(): number {
    return this._totalChunks;
  }

  reset(): void {
    this._callCount = 0;
    this._totalChunks = 0;
  }

  async synthesize(request: TTSRequest): Promise<TTSResult> {
    this._callCount++;

    const chunks = chunkText(request.text);
    this._totalChunks += chunks.length;

    // Return a predictable base64 string based on input
    const fakeAudio = Buffer.from(
      `MOCK_AUDIO:${request.languageCode}:${request.text.slice(0, 50)}`
    ).toString("base64");

    return {
      audioContent: fakeAudio,
      encoding: request.encoding ?? "MP3",
      languageCode: request.languageCode,
      chunks: chunks.length,
      latencyMs: 1,
      textBytes: getByteLength(request.text),
    };
  }

  getSupportedLanguages(): string[] {
    return [...VOICE_SUPPORTED_CODES];
  }
}

// ── Mock STT ────────────────────────────────────────────────────────────

export class MockSTTProvider implements STTProvider {
  readonly name = "mock";

  private _callCount = 0;

  get callCount(): number {
    return this._callCount;
  }

  reset(): void {
    this._callCount = 0;
  }

  async transcribe(request: STTRequest): Promise<STTResult> {
    this._callCount++;

    // Decode the base64 to get a predictable transcript
    let transcript: string;
    try {
      transcript = Buffer.from(request.audioBase64, "base64").toString("utf-8");
    } catch {
      transcript = "mock transcription";
    }

    return {
      transcript,
      confidence: 0.95,
      languageCode: request.languageCode ?? "en-US",
      latencyMs: 1,
    };
  }

  getSupportedLanguages(): string[] {
    return [...VOICE_SUPPORTED_CODES];
  }

  getSupportedEncodings(): AudioEncoding[] {
    return ["WEBM_OPUS", "OGG_OPUS", "MP3", "WAV", "FLAC", "LINEAR16"];
  }
}
