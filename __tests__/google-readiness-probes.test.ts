/**
 * TASK-197 (audit D-2, D-3): the Google readiness probes — the deployed key, and the voices the
 * platform names. voices.list and the languages list are free calls; a voice Google withdraws
 * is reported before a user's request fails.
 */

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { createGoogleTtsProbe, missingVoices } from "@/platform/voice/google-tts-health";
import { VOICE_CONFIGS } from "@/platform/voice/voices";
import { createGoogleTranslateProbe } from "@/platform/translation/google-health";

jest.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));
const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => mockFetch.mockReset());

describe("the Google probes (D-2/D-3)", () => {
  it("text-to-speech: every voice the platform names must still be offered", async () => {
    const all = { voices: VOICE_CONFIGS.map((v) => ({ name: v.voiceName })) };
    mockFetch.mockResolvedValueOnce(answer(200, all));
    expect((await createGoogleTtsProbe({ GOOGLE_API_KEY: "k" }).check()).status).toBe(
      "healthy"
    );
    mockFetch.mockResolvedValueOnce(
      answer(200, { voices: all.voices.filter((v) => v.name !== "en-US-Neural2-F") })
    );
    const r = await createGoogleTtsProbe({ GOOGLE_API_KEY: "k" }).check();
    expect(r.status).toBe("unhealthy");
    expect(r.detail).toContain("en-US-Neural2-F");
    expect(missingVoices(null).length).toBe(VOICE_CONFIGS.length);
  });

  it("a restricted key or billing off (403) is unhealthy; no key is not probed", async () => {
    mockFetch.mockResolvedValue(answer(403, { error: { status: "PERMISSION_DENIED" } }));
    expect(
      (await createGoogleTranslateProbe({ GOOGLE_API_KEY: "k" }).check()).status
    ).toBe("unhealthy");
    expect((await createGoogleTtsProbe({ GOOGLE_API_KEY: "k" }).check()).status).toBe(
      "unhealthy"
    );
    mockFetch.mockReset();
    expect((await createGoogleTranslateProbe({}).check()).status).toBe("healthy");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends the key as a header, never in the address", async () => {
    mockFetch.mockResolvedValue(answer(200, { data: { languages: [] } }));
    await createGoogleTranslateProbe({ GOOGLE_API_KEY: "secret-key" }).check();
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).not.toContain("secret-key");
    expect((init?.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe(
      "secret-key"
    );
  });
});

describe("Google at run time: a key that is not valid (TASK-197 review round 1, L-3)", () => {
  it("a 400 API_KEY_INVALID from any Google call is a credential failure, answered service.unavailable", async () => {
    const {
      GoogleTranslateProvider,
    } = require("@/platform/translation/google-translate");
    const { GoogleTTSProvider } = require("@/platform/voice/google-tts");
    const { internalError } = require("@/platform/errors");
    process.env.GOOGLE_API_KEY = "k";
    try {
      const invalid = () =>
        answer(400, {
          error: {
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
          },
        });
      mockFetch.mockImplementation(async () => invalid());
      for (const call of [
        () => new GoogleTranslateProvider().translate("hi", "es"),
        () => new GoogleTranslateProvider().detectLanguage("hi"),
        () => new GoogleTTSProvider().synthesize({ text: "hi", languageCode: "en" }),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toMatchObject({ name: "ExternalServiceError", reason: "credential" });
        const res = internalError(err);
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe("service.unavailable");
      }
    } finally {
      delete process.env.GOOGLE_API_KEY;
    }
  });
});
