import {
  translateText,
  translateToAllLanguages,
  TARGET_LANGUAGES,
} from "@/lib/translate";

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok,
    status,
    json: async () => data,
  });
}

describe("Translation Module", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    process.env.GOOGLE_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.GOOGLE_API_KEY;
  });

  describe("TARGET_LANGUAGES config", () => {
    it("should have exactly 3 target languages", () => {
      expect(TARGET_LANGUAGES).toHaveLength(3);
    });

    it("should include English", () => {
      const en = TARGET_LANGUAGES.find((l) => l.code === "en");
      expect(en).toBeDefined();
      expect(en?.language).toBe("English");
    });

    it("should include Hindi", () => {
      const hi = TARGET_LANGUAGES.find((l) => l.code === "hi");
      expect(hi).toBeDefined();
      expect(hi?.language).toBe("Hindi");
    });

    it("should include Spanish", () => {
      const es = TARGET_LANGUAGES.find((l) => l.code === "es");
      expect(es).toBeDefined();
      expect(es?.language).toBe("Spanish");
    });

    it("should have required fields on all languages", () => {
      TARGET_LANGUAGES.forEach((lang) => {
        expect(lang.code).toBeTruthy();
        expect(lang.language).toBeTruthy();
        expect(lang.flag).toBeTruthy();
      });
    });
  });

  describe("translateText", () => {
    it("returns translated text", async () => {
      mockFetchResponse({ data: { translations: [{ translatedText: "Hola mundo" }] } });
      const result = await translateText("hello world", "es");
      expect(result).toBe("Hola mundo");
    });

    it("uses X-Goog-Api-Key header not URL key", async () => {
      mockFetchResponse({ data: { translations: [{ translatedText: "test" }] } });
      await translateText("test", "es");
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain("?key=");
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
      await expect(translateText("test", "es")).rejects.toThrow(
        "Google Translate API error: 403"
      );
    });

    it("throws when API key is not configured", async () => {
      delete process.env.GOOGLE_API_KEY;
      await expect(translateText("test", "es")).rejects.toThrow(
        "GOOGLE_API_KEY is not configured"
      );
    });
  });

  describe("translateToAllLanguages", () => {
    it("returns translations for all 3 languages", async () => {
      for (const lang of TARGET_LANGUAGES) {
        mockFetchResponse({
          data: { translations: [{ translatedText: `translated-${lang.code}` }] },
        });
      }
      const results = await translateToAllLanguages("hello");
      expect(results).toHaveLength(3);
      results.forEach((r) => {
        expect(r.translated).toContain("translated-");
        expect(r.code).toBeTruthy();
      });
    });
  });
});
