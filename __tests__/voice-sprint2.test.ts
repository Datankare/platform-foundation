/**
 * Phase 3 Sprint 2 — Voice Provider Tests
 *
 * Tests: chunker (TASK-020), voice configs, mock TTS/STT,
 * Google TTS/STT (mocked fetch), provider registry.
 */

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: () => "test-req-1",
}));

// ── Chunker (TASK-020) ─────────────────────────────────────────────────

describe("Text Chunker (TASK-020)", () => {
  it("returns empty array for empty text", async () => {
    const { chunkText } = await import("@/platform/voice/chunker");
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("returns single chunk when text is under limit", async () => {
    const { chunkText } = await import("@/platform/voice/chunker");
    const chunks = chunkText("Hello world.", 5000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Hello world.");
  });

  it("splits on sentence boundaries", async () => {
    const { chunkText, getByteLength } = await import("@/platform/voice/chunker");
    const sentence1 = "A".repeat(3000) + ".";
    const sentence2 = "B".repeat(3000) + ".";
    const text = `${sentence1} ${sentence2}`;

    const chunks = chunkText(text, 5000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((chunk) => {
      expect(getByteLength(chunk)).toBeLessThanOrEqual(5000);
    });
  });

  it("handles Unicode multi-byte characters", async () => {
    const { chunkText, getByteLength } = await import("@/platform/voice/chunker");
    // Hindi characters are 3 bytes each in UTF-8
    const hindi = "\u0928\u092e\u0938\u094d\u0924\u0947".repeat(1000); // ~6000 bytes
    const chunks = chunkText(hindi, 5000);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((chunk) => {
      expect(getByteLength(chunk)).toBeLessThanOrEqual(5000);
    });
  });

  it("handles text with no sentence boundaries", async () => {
    const { chunkText, getByteLength } = await import("@/platform/voice/chunker");
    const longWord = "a".repeat(8000);
    const chunks = chunkText(longWord, 5000);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((chunk) => {
      expect(getByteLength(chunk)).toBeLessThanOrEqual(5000);
    });
  });

  it("splits on clause boundaries when sentences are too long", async () => {
    const { chunkText, getByteLength } = await import("@/platform/voice/chunker");
    // One long "sentence" with commas
    const text =
      Array.from({ length: 20 }, (_, i) => `clause ${i} ${"x".repeat(300)}`).join(", ") +
      ".";

    const chunks = chunkText(text, 5000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((chunk) => {
      expect(getByteLength(chunk)).toBeLessThanOrEqual(5000);
    });
  });

  it("getByteLength counts multi-byte correctly", async () => {
    const { getByteLength } = await import("@/platform/voice/chunker");
    expect(getByteLength("hello")).toBe(5);
    expect(getByteLength("\u4f60\u597d")).toBe(6); // Chinese: 3 bytes each
    expect(getByteLength("\u0928\u092e")).toBe(6); // Hindi: 3 bytes each
  });

  it("exactly 5000 bytes returns single chunk", async () => {
    const { chunkText } = await import("@/platform/voice/chunker");
    const text = "a".repeat(5000);
    const chunks = chunkText(text, 5000);
    expect(chunks).toHaveLength(1);
  });

  it("5001 bytes splits into two chunks", async () => {
    const { chunkText } = await import("@/platform/voice/chunker");
    const text = "a".repeat(5001);
    const chunks = chunkText(text, 5000);
    expect(chunks).toHaveLength(2);
  });
});

// ── Voice Configs ───────────────────────────────────────────────────────

describe("Voice Configurations", () => {
  it("has configs for all 10 languages", async () => {
    const { VOICE_CONFIGS } = await import("@/platform/voice/voices");
    expect(VOICE_CONFIGS).toHaveLength(10);
  });

  it("every config has required fields", async () => {
    const { VOICE_CONFIGS } = await import("@/platform/voice/voices");
    for (const config of VOICE_CONFIGS) {
      expect(config.code).toBeTruthy();
      expect(config.languageCode).toBeTruthy();
      expect(config.voiceName).toBeTruthy();
      expect(config.sttLanguageCode).toBeTruthy();
    }
  });

  it("getVoiceConfig returns config or English fallback", async () => {
    const { getVoiceConfig } = await import("@/platform/voice/voices");
    const en = getVoiceConfig("en");
    expect(en.voiceName).toBe("en-US-Neural2-F");

    const ar = getVoiceConfig("ar");
    expect(ar.voiceName).toBe("ar-XA-Wavenet-A");

    const unknown = getVoiceConfig("xx");
    expect(unknown.code).toBe("en"); // fallback
  });

  it("Telugu uses Standard (not Neural2/Wavenet)", async () => {
    const { getVoiceConfig } = await import("@/platform/voice/voices");
    const te = getVoiceConfig("te");
    expect(te.voiceName).toContain("Standard");
  });

  it("AUTO_DETECT_POOL has 6 languages", async () => {
    const { AUTO_DETECT_POOL } = await import("@/platform/voice/voices");
    expect(AUTO_DETECT_POOL).toHaveLength(6);
    expect(AUTO_DETECT_POOL).toContain("en-US");
    expect(AUTO_DETECT_POOL).toContain("cmn-CN");
  });

  it("hasVoiceSupport checks correctly", async () => {
    const { hasVoiceSupport } = await import("@/platform/voice/voices");
    expect(hasVoiceSupport("en")).toBe(true);
    expect(hasVoiceSupport("te")).toBe(true);
    expect(hasVoiceSupport("xx")).toBe(false);
  });
});

// ── Mock TTS ────────────────────────────────────────────────────────────

describe("MockTTSProvider", () => {
  it("returns predictable audio content", async () => {
    const { MockTTSProvider } = await import("@/platform/voice/mock-voice");
    const provider = new MockTTSProvider();

    const result = await provider.synthesize({
      text: "Hello",
      languageCode: "en",
    });

    expect(result.audioContent).toBeTruthy();
    expect(result.languageCode).toBe("en");
    expect(result.chunks).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Decode to verify content
    const decoded = Buffer.from(result.audioContent, "base64").toString("utf-8");
    expect(decoded).toContain("MOCK_AUDIO:en:");
  });

  it("tracks call count and chunk count", async () => {
    const { MockTTSProvider } = await import("@/platform/voice/mock-voice");
    const provider = new MockTTSProvider();

    await provider.synthesize({ text: "Hello", languageCode: "en" });
    await provider.synthesize({ text: "World", languageCode: "es" });

    expect(provider.callCount).toBe(2);
    expect(provider.totalChunks).toBe(2);

    provider.reset();
    expect(provider.callCount).toBe(0);
  });

  it("reports correct chunk count for long text", async () => {
    const { MockTTSProvider } = await import("@/platform/voice/mock-voice");
    const provider = new MockTTSProvider();

    const longText = "Hello world. ".repeat(500); // well over 5000 bytes
    const result = await provider.synthesize({
      text: longText,
      languageCode: "en",
    });

    expect(result.chunks).toBeGreaterThan(1);
  });
});

// ── Mock STT ────────────────────────────────────────────────────────────

describe("MockSTTProvider", () => {
  it("returns transcription from base64 input", async () => {
    const { MockSTTProvider } = await import("@/platform/voice/mock-voice");
    const provider = new MockSTTProvider();

    const audio = Buffer.from("Hello from audio").toString("base64");
    const result = await provider.transcribe({ audioBase64: audio });

    expect(result.transcript).toBe("Hello from audio");
    expect(result.confidence).toBe(0.95);
  });

  it("returns all supported encodings", async () => {
    const { MockSTTProvider } = await import("@/platform/voice/mock-voice");
    const provider = new MockSTTProvider();
    const encodings = provider.getSupportedEncodings();

    expect(encodings).toContain("WEBM_OPUS");
    expect(encodings).toContain("MP3");
    expect(encodings).toContain("WAV");
  });
});

// ── Google TTS (mocked fetch) ───────────────────────────────────────────

describe("GoogleTTSProvider", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("synthesize returns audio content", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ audioContent: "base64audio==" }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: mockFetch }));
    jest.doMock("@/shared/config/apiKeys", () => ({ getGoogleApiKey: () => "key" }));
    jest.doMock("@/lib/sanitize", () => ({ sanitizeLanguageCode: (c: string) => c }));
    jest.doMock("@/lib/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      generateRequestId: () => "req-1",
    }));

    const { GoogleTTSProvider } = await import("@/platform/voice/google-tts");
    const provider = new GoogleTTSProvider();

    const result = await provider.synthesize({
      text: "Hello",
      languageCode: "en",
    });

    expect(result.audioContent).toBe("base64audio==");
    expect(result.chunks).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice.name).toBe("en-US-Neural2-F");
  });

  it("chunks long text into multiple API calls", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ audioContent: "Y2h1bms=" }), // "chunk" in base64
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: mockFetch }));
    jest.doMock("@/shared/config/apiKeys", () => ({ getGoogleApiKey: () => "key" }));
    jest.doMock("@/lib/sanitize", () => ({ sanitizeLanguageCode: (c: string) => c }));
    jest.doMock("@/lib/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      generateRequestId: () => "req-1",
    }));

    const { GoogleTTSProvider } = await import("@/platform/voice/google-tts");
    const provider = new GoogleTTSProvider();

    const longText = "This is a sentence. ".repeat(300);
    const result = await provider.synthesize({
      text: longText,
      languageCode: "es",
    });

    expect(result.chunks).toBeGreaterThan(1);
    expect(mockFetch.mock.calls.length).toBe(result.chunks);
  });

  it("throws on API error", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });

    jest.doMock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: mockFetch }));
    jest.doMock("@/shared/config/apiKeys", () => ({ getGoogleApiKey: () => "key" }));
    jest.doMock("@/lib/sanitize", () => ({ sanitizeLanguageCode: (c: string) => c }));
    jest.doMock("@/lib/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      generateRequestId: () => "req-1",
    }));

    const { GoogleTTSProvider } = await import("@/platform/voice/google-tts");
    const provider = new GoogleTTSProvider();

    await expect(
      provider.synthesize({ text: "Hello", languageCode: "en" })
    ).rejects.toThrow("Google TTS API error: 403");
  });
});

// ── Google STT (mocked fetch) ───────────────────────────────────────────

describe("GoogleSTTProvider", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("transcribe returns result", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              alternatives: [{ transcript: "Hello world", confidence: 0.96 }],
              languageCode: "en-us",
            },
          ],
        }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: mockFetch }));
    jest.doMock("@/shared/config/apiKeys", () => ({ getGoogleApiKey: () => "key" }));
    jest.doMock("@/lib/sanitize", () => ({ sanitizeLanguageCode: (c: string) => c }));
    jest.doMock("@/lib/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      generateRequestId: () => "req-1",
    }));

    const { GoogleSTTProvider } = await import("@/platform/voice/google-stt");
    const provider = new GoogleSTTProvider();

    const result = await provider.transcribe({
      audioBase64: "dGVzdA==",
      encoding: "WEBM_OPUS",
    });

    expect(result.transcript).toBe("Hello world");
    expect(result.confidence).toBe(0.96);
    expect(result.languageCode).toBe("en");
  });

  it("normalizes zh-CN to zh", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              alternatives: [{ transcript: "\u4f60\u597d", confidence: 0.9 }],
              languageCode: "cmn-cn",
            },
          ],
        }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: mockFetch }));
    jest.doMock("@/shared/config/apiKeys", () => ({ getGoogleApiKey: () => "key" }));
    jest.doMock("@/lib/sanitize", () => ({ sanitizeLanguageCode: (c: string) => c }));
    jest.doMock("@/lib/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      generateRequestId: () => "req-1",
    }));

    const { GoogleSTTProvider } = await import("@/platform/voice/google-stt");
    const provider = new GoogleSTTProvider();

    const result = await provider.transcribe({ audioBase64: "dGVzdA==" });
    expect(result.languageCode).toBe("zh");
  });

  it("returns empty transcript when no results", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: mockFetch }));
    jest.doMock("@/shared/config/apiKeys", () => ({ getGoogleApiKey: () => "key" }));
    jest.doMock("@/lib/sanitize", () => ({ sanitizeLanguageCode: (c: string) => c }));
    jest.doMock("@/lib/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      generateRequestId: () => "req-1",
    }));

    const { GoogleSTTProvider } = await import("@/platform/voice/google-stt");
    const provider = new GoogleSTTProvider();

    const result = await provider.transcribe({ audioBase64: "dGVzdA==" });
    expect(result.transcript).toBe("");
    expect(result.confidence).toBe(0);
  });

  it("passes auto-detect config with alternative languages", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              alternatives: [{ transcript: "Hola", confidence: 0.9 }],
              languageCode: "es-es",
            },
          ],
        }),
    });

    jest.doMock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: mockFetch }));
    jest.doMock("@/shared/config/apiKeys", () => ({ getGoogleApiKey: () => "key" }));
    jest.doMock("@/lib/sanitize", () => ({ sanitizeLanguageCode: (c: string) => c }));
    jest.doMock("@/lib/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      generateRequestId: () => "req-1",
    }));

    const { GoogleSTTProvider } = await import("@/platform/voice/google-stt");
    const provider = new GoogleSTTProvider();

    await provider.transcribe({
      audioBase64: "dGVzdA==",
      autoDetect: true,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.config.alternativeLanguageCodes).toBeDefined();
    expect(body.config.alternativeLanguageCodes.length).toBeGreaterThan(0);
  });
});

// ── Provider Registry ───────────────────────────────────────────────────

describe("Provider Registry — voice slots", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("defaults to mock TTS and STT", async () => {
    delete process.env.TTS_PROVIDER;
    delete process.env.STT_PROVIDER;

    const { getActiveProviders } = await import("@/platform/providers/registry");
    const providers = getActiveProviders();
    expect(providers.tts).toBe("mock");
    expect(providers.stt).toBe("mock");
  });

  it("reads TTS_PROVIDER and STT_PROVIDER from env", async () => {
    process.env.TTS_PROVIDER = "google";
    process.env.STT_PROVIDER = "google";

    const { getActiveProviders } = await import("@/platform/providers/registry");
    const providers = getActiveProviders();
    expect(providers.tts).toBe("google");
    expect(providers.stt).toBe("google");

    delete process.env.TTS_PROVIDER;
    delete process.env.STT_PROVIDER;
  });
});

// ── Module exports ──────────────────────────────────────────────────────

describe("Voice module exports", () => {
  it("exports all public API", async () => {
    const mod = await import("@/platform/voice/index");

    // Voices
    expect(mod.VOICE_CONFIGS).toBeDefined();
    expect(mod.VOICE_SUPPORTED_CODES).toBeDefined();
    expect(mod.AUTO_DETECT_POOL).toBeDefined();
    expect(mod.getVoiceConfig).toBeDefined();
    expect(mod.hasVoiceSupport).toBeDefined();

    // Chunker
    expect(mod.chunkText).toBeDefined();
    expect(mod.getByteLength).toBeDefined();
    expect(mod.TTS_BYTE_LIMIT).toBe(5000);

    // Providers
    expect(mod.GoogleTTSProvider).toBeDefined();
    expect(mod.GoogleSTTProvider).toBeDefined();
    expect(mod.MockTTSProvider).toBeDefined();
    expect(mod.MockSTTProvider).toBeDefined();
  });
});
