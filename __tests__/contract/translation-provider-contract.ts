/**
 * __tests__/contract/translation-provider-contract.ts
 *
 * TranslationProvider conformance kit (TCK) — ADR-027.
 * Provider-agnostic behavioral contract. PF runs it against the mock and the
 * Google reference impl; consumers run it against their own.
 *
 * Not a *.test.ts — never run standalone. GenAI principles: P1, P7, P9.
 */

import type { TranslationProvider } from "@/platform/translation/types";

export const TRANSLATION_CONTRACT = {
  sampleText: "Hello, world.",
  targetLanguage: "es",
  sourceLanguage: "en",
} as const;

export interface TranslationContractFixtures {
  makeProvider: () => TranslationProvider | Promise<TranslationProvider>;
}

export function runTranslationProviderContract(fx: TranslationContractFixtures): void {
  const C = TRANSLATION_CONTRACT;
  let provider: TranslationProvider;

  beforeEach(async () => {
    provider = await fx.makeProvider();
  });

  describe("name", () => {
    it("exposes a non-empty provider name", () => {
      expect(typeof provider.name).toBe("string");
      expect(provider.name.length).toBeGreaterThan(0);
    });
  });

  describe("translate", () => {
    it("returns a well-formed result for the requested target language", async () => {
      const r = await provider.translate(C.sampleText, C.targetLanguage);
      expect(typeof r.text).toBe("string");
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.targetLanguage).toBe(C.targetLanguage);
      expect(typeof r.sourceLanguage).toBe("string");
      expect(r.sourceLanguage.length).toBeGreaterThan(0);
      expect(typeof r.cached).toBe("boolean");
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("echoes an explicitly provided source language", async () => {
      const r = await provider.translate(
        C.sampleText,
        C.targetLanguage,
        C.sourceLanguage
      );
      expect(r.sourceLanguage).toBe(C.sourceLanguage);
      expect(r.targetLanguage).toBe(C.targetLanguage);
    });
  });

  describe("detectLanguage", () => {
    it("returns a language code with confidence in [0,1]", async () => {
      const r = await provider.detectLanguage(C.sampleText);
      expect(typeof r.language).toBe("string");
      expect(r.language.length).toBeGreaterThan(0);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getSupportedLanguages", () => {
    it("returns a non-empty list of language codes", () => {
      const langs = provider.getSupportedLanguages();
      expect(Array.isArray(langs)).toBe(true);
      expect(langs.length).toBeGreaterThan(0);
      langs.forEach((l) => expect(typeof l).toBe("string"));
    });
  });
}
