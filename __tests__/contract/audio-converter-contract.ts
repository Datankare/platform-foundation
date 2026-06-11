/**
 * __tests__/contract/audio-converter-contract.ts
 * AudioFormatConverter conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type {
  AudioFormatConverter,
  SourceAudioFormat,
} from "@/platform/voice/audio-format-types";

export interface AudioConverterContractFixtures {
  makeConverter: () => AudioFormatConverter | Promise<AudioFormatConverter>;
}

export function runAudioConverterContract(fx: AudioConverterContractFixtures): void {
  let converter: AudioFormatConverter;

  beforeEach(async () => {
    converter = await fx.makeConverter();
  });

  describe("name", () => {
    it("exposes a non-empty provider name", () => {
      expect(typeof converter.name).toBe("string");
      expect(converter.name.length).toBeGreaterThan(0);
    });
  });

  describe("convert", () => {
    it("converts a non-canonical source to canonical output", async () => {
      const source: SourceAudioFormat = "mp3";
      const audio = Buffer.from("contract-source-audio");
      const r = await converter.convert({ audioData: audio, sourceFormat: source });
      expect(Buffer.isBuffer(r.audioData)).toBe(true);
      expect(r.audioData.length).toBeGreaterThan(0);
      expect(r.sourceFormat).toBe(source);
      expect(r.converted).toBe(true);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(r.sourceSizeBytes).toBe(audio.length);
      expect(r.outputSizeBytes).toBeGreaterThan(0);
      expect(r.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    });

    it("returns a boolean converted flag for a wav source", async () => {
      const r = await converter.convert({
        audioData: Buffer.from("wav-bytes"),
        sourceFormat: "wav",
      });
      expect(typeof r.converted).toBe("boolean");
    });
  });

  describe("format support", () => {
    it("reports supported formats", () => {
      const formats = converter.getSupportedFormats();
      expect(Array.isArray(formats)).toBe(true);
      expect(formats.length).toBeGreaterThan(0);
      expect(converter.supportsFormat(formats[0])).toBe(true);
    });
  });
}
