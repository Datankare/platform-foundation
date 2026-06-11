/**
 * __tests__/contract/tts-provider-contract.ts
 *
 * TTSProvider conformance kit (TCK) — ADR-027.
 * Not a *.test.ts. GenAI principles: P1, P7, P9, P11.
 */

import type { TTSProvider, AudioEncoding } from "@/platform/voice/types";

const VALID_ENCODINGS: AudioEncoding[] = [
  "WEBM_OPUS",
  "OGG_OPUS",
  "MP3",
  "WAV",
  "FLAC",
  "LINEAR16",
];

export const TTS_CONTRACT = {
  text: "Hello, world.",
  languageCode: "en",
  encoding: "MP3" as AudioEncoding,
} as const;

export interface TTSContractFixtures {
  makeProvider: () => TTSProvider | Promise<TTSProvider>;
}

export function runTTSProviderContract(fx: TTSContractFixtures): void {
  const C = TTS_CONTRACT;
  let provider: TTSProvider;

  beforeEach(async () => {
    provider = await fx.makeProvider();
  });

  describe("name", () => {
    it("exposes a non-empty provider name", () => {
      expect(typeof provider.name).toBe("string");
      expect(provider.name.length).toBeGreaterThan(0);
    });
  });

  describe("synthesize", () => {
    it("returns audio content with a valid encoding and matching language", async () => {
      const r = await provider.synthesize({
        text: C.text,
        languageCode: C.languageCode,
      });
      expect(typeof r.audioContent).toBe("string");
      expect(r.audioContent.length).toBeGreaterThan(0);
      expect(VALID_ENCODINGS).toContain(r.encoding);
      expect(r.languageCode).toBe(C.languageCode);
      expect(r.chunks).toBeGreaterThanOrEqual(1);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(r.textBytes).toBeGreaterThan(0);
    });

    it("honors a requested encoding", async () => {
      const r = await provider.synthesize({
        text: C.text,
        languageCode: C.languageCode,
        encoding: C.encoding,
      });
      expect(r.encoding).toBe(C.encoding);
    });
  });

  describe("getSupportedLanguages", () => {
    it("returns a non-empty list of language codes", () => {
      const langs = provider.getSupportedLanguages();
      expect(Array.isArray(langs)).toBe(true);
      expect(langs.length).toBeGreaterThan(0);
    });
  });
}
