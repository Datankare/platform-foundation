/**
 * __tests__/contract/stt-provider-contract.ts
 *
 * STTProvider conformance kit (TCK) — ADR-027.
 * Not a *.test.ts. GenAI principles: P1, P7, P9.
 */

import type { STTProvider, AudioEncoding } from "@/platform/voice/types";

const VALID_ENCODINGS: AudioEncoding[] = [
  "WEBM_OPUS",
  "OGG_OPUS",
  "MP3",
  "WAV",
  "FLAC",
  "LINEAR16",
];

export const STT_CONTRACT = {
  languageCode: "en-US",
} as const;

export interface STTContractFixtures {
  makeProvider: () => STTProvider | Promise<STTProvider>;
  /** Impl-specific: audio the implementation can transcribe offline. */
  sampleAudioBase64: string;
}

export function runSTTProviderContract(fx: STTContractFixtures): void {
  const C = STT_CONTRACT;
  let provider: STTProvider;

  beforeEach(async () => {
    provider = await fx.makeProvider();
  });

  describe("name", () => {
    it("exposes a non-empty provider name", () => {
      expect(typeof provider.name).toBe("string");
      expect(provider.name.length).toBeGreaterThan(0);
    });
  });

  describe("transcribe", () => {
    it("returns a transcript with confidence in [0,1]", async () => {
      const r = await provider.transcribe({ audioBase64: fx.sampleAudioBase64 });
      expect(typeof r.transcript).toBe("string");
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(typeof r.languageCode).toBe("string");
      expect(r.languageCode.length).toBeGreaterThan(0);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("returns a language consistent with the request", async () => {
      const r = await provider.transcribe({
        audioBase64: fx.sampleAudioBase64,
        languageCode: C.languageCode,
      });
      // The returned code is the detected/normalized language, which a real
      // provider may reduce to its base (e.g. "en-US" -> "en"). The contract
      // requires consistency with the request at the base-language level, not
      // a verbatim echo of the requested code.
      expect(C.languageCode.toLowerCase().startsWith(r.languageCode.toLowerCase())).toBe(
        true
      );
    });
  });

  describe("getSupportedLanguages", () => {
    it("returns a non-empty list", () => {
      const langs = provider.getSupportedLanguages();
      expect(Array.isArray(langs)).toBe(true);
      expect(langs.length).toBeGreaterThan(0);
    });
  });

  describe("getSupportedEncodings", () => {
    it("returns a non-empty list of valid audio encodings", () => {
      const encs = provider.getSupportedEncodings();
      expect(Array.isArray(encs)).toBe(true);
      expect(encs.length).toBeGreaterThan(0);
      encs.forEach((e) => expect(VALID_ENCODINGS).toContain(e));
    });
  });
}
