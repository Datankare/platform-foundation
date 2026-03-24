import { textToSpeech } from "@/lib/tts";

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockTTSResponse(audioContent: string, ok = true, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok,
    status,
    json: async () => ({ audioContent }),
  });
}

describe("textToSpeech — real function", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    process.env.GOOGLE_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.GOOGLE_API_KEY;
  });

  it("returns audio content base64 string", async () => {
    mockTTSResponse("base64audiodata==");
    const result = await textToSpeech("Hello world", "en");
    expect(result).toBe("base64audiodata==");
  });

  it("uses X-Goog-Api-Key header not URL key", async () => {
    mockTTSResponse("audio==");
    await textToSpeech("test", "en");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("?key=");
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
  });

  it("uses neural voice for English", async () => {
    mockTTSResponse("audio==");
    await textToSpeech("hello", "en");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice.languageCode).toBe("en-US");
    expect(body.voice.name).toContain("Neural2");
  });

  it("falls back to English voice for unknown language code", async () => {
    mockTTSResponse("audio==");
    await textToSpeech("hello", "xx");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice.languageCode).toBe("en-US");
  });

  it("uses MP3 audio encoding", async () => {
    mockTTSResponse("audio==");
    await textToSpeech("test", "en");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.audioConfig.audioEncoding).toBe("MP3");
  });

  it("uses Hindi voice for hi language code", async () => {
    mockTTSResponse("audio==");
    await textToSpeech("नमस्ते", "hi");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice.languageCode).toBe("hi-IN");
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(textToSpeech("test", "en")).rejects.toThrow("Google TTS API error: 500");
  });

  it("throws when API key is not configured", async () => {
    delete process.env.GOOGLE_API_KEY;
    await expect(textToSpeech("test", "en")).rejects.toThrow(
      "GOOGLE_API_KEY is not configured"
    );
  });
});
