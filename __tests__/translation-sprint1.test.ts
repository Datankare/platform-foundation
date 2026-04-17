/**
 * Phase 3 Sprint 1 — Translation Provider Tests
 *
 * Tests the translation provider abstraction:
 * types, languages registry, mock provider, Google provider (mocked fetch),
 * fan-out translation, and provider registry integration.
 */

import type {
  TranslationProvider,
  LanguageDefinition,
} from "@/platform/translation/types";

jest.mock("@/lib/logger", () => ({
  generateRequestId: () => "test-req-1",
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Languages Registry ──────────────────────────────────────────────────

describe("Language Registry", () => {
  it("exports 10 languages", async () => {
    const { LANGUAGES } = await import("@/platform/translation/languages");
    expect(LANGUAGES).toHaveLength(10);
  });

  it("every language has required fields", async () => {
    const { LANGUAGES } = await import("@/platform/translation/languages");
    for (const lang of LANGUAGES) {
      expect(lang.code).toBeTruthy();
      expect(lang.language).toBeTruthy();
      expect(lang.flag).toBeTruthy();
      expect(typeof lang.rtl).toBe("boolean");
      expect(typeof lang.baseline).toBe("boolean");
    }
  });

  it("has 3 baseline languages (en, es, fr)", async () => {
    const { BASELINE_CODES } = await import("@/platform/translation/languages");
    expect(BASELINE_CODES).toHaveLength(3);
    expect(BASELINE_CODES).toContain("en");
    expect(BASELINE_CODES).toContain("es");
    expect(BASELINE_CODES).toContain("fr");
  });

  it("marks Arabic as RTL", async () => {
    const { RTL_CODES, isRTL } = await import("@/platform/translation/languages");
    expect(RTL_CODES).toContain("ar");
    expect(isRTL("ar")).toBe(true);
    expect(isRTL("en")).toBe(false);
  });

  it("getLanguage returns definition or undefined", async () => {
    const { getLanguage } = await import("@/platform/translation/languages");
    const en = getLanguage("en");
    expect(en).toBeDefined();
    expect(en?.language).toBe("English");

    const unknown = getLanguage("xx");
    expect(unknown).toBeUndefined();
  });

  it("isSupported checks correctly", async () => {
    const { isSupported } = await import("@/platform/translation/languages");
    expect(isSupported("en")).toBe(true);
    expect(isSupported("hi")).toBe(true);
    expect(isSupported("xx")).toBe(false);
  });

  it("DEFAULT_OUTPUT_MAP: en→es, others→en", async () => {
    const { DEFAULT_OUTPUT_MAP } = await import("@/platform/translation/languages");
    expect(DEFAULT_OUTPUT_MAP["en"]).toBe("es");
    expect(DEFAULT_OUTPUT_MAP["es"]).toBe("en");
    expect(DEFAULT_OUTPUT_MAP["hi"]).toBe("en");
    expect(DEFAULT_OUTPUT_MAP["ar"]).toBe("en");
  });

  it("getDefaultOutputLanguage constrains to user selection", async () => {
    const { getDefaultOutputLanguage } = await import("@/platform/translation/languages");
    // User has es available — default for en input is es
    expect(getDefaultOutputLanguage("en", ["es", "fr"])).toBe("es");
    // User doesn't have es — falls back to en
    expect(getDefaultOutputLanguage("en", ["fr", "hi"])).toBe("en");
    // Hindi input → default is en, user has en
    expect(getDefaultOutputLanguage("hi", ["en", "es"])).toBe("en");
  });

  it("language codes are unique", async () => {
    const { LANGUAGES } = await import("@/platform/translation/languages");
    const codes = LANGUAGES.map((l: LanguageDefinition) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ── Mock Provider ───────────────────────────────────────────────────────

describe("MockTranslateProvider", () => {
  it("returns deterministic translations", async () => {
    const { MockTranslateProvider } =
      await import("@/platform/translation/mock-translate");
    const provider = new MockTranslateProvider();

    const result = await provider.translate("Hello", "es");
    expect(result.text).toBe("[MOCK:es] Hello");
    expect(result.targetLanguage).toBe("es");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.cached).toBe(false);
  });

  it("tracks call counts", async () => {
    const { MockTranslateProvider } =
      await import("@/platform/translation/mock-translate");
    const provider = new MockTranslateProvider();

    expect(provider.callCount).toBe(0);
    await provider.translate("Hello", "es");
    await provider.translate("World", "fr");
    expect(provider.callCount).toBe(2);

    provider.reset();
    expect(provider.callCount).toBe(0);
  });

  it("detects language by Unicode range", async () => {
    const { MockTranslateProvider } =
      await import("@/platform/translation/mock-translate");
    const provider = new MockTranslateProvider();

    const en = await provider.detectLanguage("Hello");
    expect(en.language).toBe("en");
    expect(en.confidence).toBeGreaterThan(0);

    const zh = await provider.detectLanguage("\u4f60\u597d");
    expect(zh.language).toBe("zh");
  });

  it("returns all supported languages", async () => {
    const { MockTranslateProvider } =
      await import("@/platform/translation/mock-translate");
    const provider = new MockTranslateProvider();
    const langs = provider.getSupportedLanguages();
    expect(langs).toHaveLength(10);
    expect(langs).toContain("en");
    expect(langs).toContain("te");
  });

  it("implements TranslationProvider interface", async () => {
    const { MockTranslateProvider } =
      await import("@/platform/translation/mock-translate");
    const provider: TranslationProvider = new MockTranslateProvider();
    expect(provider.name).toBe("mock");
    expect(typeof provider.translate).toBe("function");
    expect(typeof provider.detectLanguage).toBe("function");
    expect(typeof provider.getSupportedLanguages).toBe("function");
  });
});

// ── Google Provider (mocked fetch) ──────────────────────────────────────

describe("GoogleTranslateProvider", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("translate calls Google API and returns result", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            translations: [
              {
                translatedText: "Hola",
                detectedSourceLanguage: "en",
              },
            ],
          },
        }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({
      fetchWithTimeout: mockFetch,
    }));
    jest.doMock("@/shared/config/apiKeys", () => ({
      getGoogleApiKey: () => "test-key",
    }));
    jest.doMock("@/lib/sanitize", () => ({
      sanitizeLanguageCode: (c: string) => c,
    }));

    const { GoogleTranslateProvider } =
      await import("@/platform/translation/google-translate");
    const provider = new GoogleTranslateProvider();

    const result = await provider.translate("Hello", "es");
    expect(result.text).toBe("Hola");
    expect(result.sourceLanguage).toBe("en");
    expect(result.targetLanguage).toBe("es");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.cached).toBe(false);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("translate/v2");
    expect(opts.headers["X-Goog-Api-Key"]).toBe("test-key");
  });

  it("detectLanguage normalizes zh-CN to zh", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            detections: [[{ language: "zh-CN", confidence: 0.98 }]],
          },
        }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({
      fetchWithTimeout: mockFetch,
    }));
    jest.doMock("@/shared/config/apiKeys", () => ({
      getGoogleApiKey: () => "test-key",
    }));
    jest.doMock("@/lib/sanitize", () => ({
      sanitizeLanguageCode: (c: string) => c,
    }));

    const { GoogleTranslateProvider } =
      await import("@/platform/translation/google-translate");
    const provider = new GoogleTranslateProvider();

    const result = await provider.detectLanguage("\u4f60\u597d");
    expect(result.language).toBe("zh");
    expect(result.confidence).toBe(0.98);
  });

  it("throws on API error", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({
      fetchWithTimeout: mockFetch,
    }));
    jest.doMock("@/shared/config/apiKeys", () => ({
      getGoogleApiKey: () => "test-key",
    }));
    jest.doMock("@/lib/sanitize", () => ({
      sanitizeLanguageCode: (c: string) => c,
    }));

    const { GoogleTranslateProvider } =
      await import("@/platform/translation/google-translate");
    const provider = new GoogleTranslateProvider();

    await expect(provider.translate("Hello", "es")).rejects.toThrow(
      "Google Translate API error: 403"
    );
  });

  it("passes sourceLanguage when provided", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            translations: [{ translatedText: "Bonjour" }],
          },
        }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({
      fetchWithTimeout: mockFetch,
    }));
    jest.doMock("@/shared/config/apiKeys", () => ({
      getGoogleApiKey: () => "test-key",
    }));
    jest.doMock("@/lib/sanitize", () => ({
      sanitizeLanguageCode: (c: string) => c,
    }));

    const { GoogleTranslateProvider } =
      await import("@/platform/translation/google-translate");
    const provider = new GoogleTranslateProvider();

    await provider.translate("Hello", "fr", "en");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.source).toBe("en");
    expect(body.target).toBe("fr");
  });

  it("getSupportedLanguages returns 10 codes", async () => {
    jest.doMock("@/lib/fetchWithTimeout", () => ({
      fetchWithTimeout: jest.fn(),
    }));
    jest.doMock("@/shared/config/apiKeys", () => ({
      getGoogleApiKey: () => "test-key",
    }));
    jest.doMock("@/lib/sanitize", () => ({
      sanitizeLanguageCode: (c: string) => c,
    }));

    const { GoogleTranslateProvider } =
      await import("@/platform/translation/google-translate");
    const provider = new GoogleTranslateProvider();
    expect(provider.getSupportedLanguages()).toHaveLength(10);
  });
});

// ── Provider Registry ───────────────────────────────────────────────────

describe("Provider Registry — translation slot", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("defaults to mock translation provider", async () => {
    delete process.env.TRANSLATION_PROVIDER;

    const { getActiveProviders } = await import("@/platform/providers/registry");
    const providers = getActiveProviders();
    expect(providers.translation).toBe("mock");
  });

  it("reads TRANSLATION_PROVIDER from env", async () => {
    process.env.TRANSLATION_PROVIDER = "google";

    const { getActiveProviders } = await import("@/platform/providers/registry");
    const providers = getActiveProviders();
    expect(providers.translation).toBe("google");

    delete process.env.TRANSLATION_PROVIDER;
  });
});

// ── Index exports ───────────────────────────────────────────────────────

describe("Translation module exports", () => {
  it("exports all public API", async () => {
    const mod = await import("@/platform/translation/index");

    // Languages
    expect(mod.LANGUAGES).toBeDefined();
    expect(mod.SUPPORTED_CODES).toBeDefined();
    expect(mod.BASELINE_CODES).toBeDefined();
    expect(mod.RTL_CODES).toBeDefined();
    expect(mod.DEFAULT_OUTPUT_MAP).toBeDefined();
    expect(mod.getLanguage).toBeDefined();
    expect(mod.isSupported).toBeDefined();
    expect(mod.isRTL).toBeDefined();
    expect(mod.getDefaultOutputLanguage).toBeDefined();

    // Providers
    expect(mod.GoogleTranslateProvider).toBeDefined();
    expect(mod.MockTranslateProvider).toBeDefined();
  });
});
