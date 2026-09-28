/**
 * ADR-050 D3 / TASK-104 — optional features are offered only when configured.
 */
import {
  FEATURE_REQUIREMENTS,
  featureAvailability,
  isFeatureAvailable,
} from "@/platform/features/availability";
import { requireFeature } from "@/platform/features/guard";
import { GET } from "@/app/api/features/route";

const ACR = {
  SONG_ID_PROVIDER: "acrcloud",
  ACRCLOUD_HOST: "h",
  ACRCLOUD_ACCESS_KEY: "k",
  ACRCLOUD_ACCESS_SECRET: "s",
};
const FFMPEG = {
  AUDIO_CONVERTER: "ffmpeg-service",
  AUDIO_CONVERTER_URL: "https://ffmpeg.example",
  AUDIO_CONVERTER_KEY: "key",
};

describe("featureAvailability", () => {
  it("nothing optional is offered on a bare deployment, except the Teams preview", () => {
    expect(featureAvailability({})).toEqual({
      music_identification: { available: false },
      audio_upload: { available: false },
      speech_input: { available: false },
      teams: { available: true, preview: true },
    });
  });

  it("playform-dev today: speech input only (no song ID, no converter)", () => {
    const env = {
      GOOGLE_API_KEY: "g",
      AUDIO_CONVERTER: "mock",
      SONG_ID_PROVIDER: "mock",
    };
    expect(isFeatureAvailable("speech_input", env)).toBe(true);
    expect(isFeatureAvailable("audio_upload", env)).toBe(false);
    expect(isFeatureAvailable("music_identification", env)).toBe(false);
  });

  it("music identification needs ACRCloud and a real converter", () => {
    expect(isFeatureAvailable("music_identification", { ...ACR, ...FFMPEG })).toBe(true);
    expect(isFeatureAvailable("music_identification", ACR)).toBe(false);
    expect(isFeatureAvailable("music_identification", { ...FFMPEG })).toBe(false);
    expect(
      isFeatureAvailable("music_identification", {
        ...ACR,
        ...FFMPEG,
        ACRCLOUD_HOST: " ",
      })
    ).toBe(false);
    expect(
      isFeatureAvailable("music_identification", {
        ...ACR,
        ...FFMPEG,
        AUDIO_CONVERTER: "passthrough",
      })
    ).toBe(false);
  });

  it("audio upload needs a speech key and a real converter", () => {
    expect(isFeatureAvailable("audio_upload", { GOOGLE_API_KEY: "g", ...FFMPEG })).toBe(
      true
    );
    expect(
      isFeatureAvailable("audio_upload", { NEXT_PUBLIC_GOOGLE_API_KEY: "g", ...FFMPEG })
    ).toBe(true);
    expect(
      isFeatureAvailable("audio_upload", {
        GOOGLE_API_KEY: "g",
        ...FFMPEG,
        AUDIO_CONVERTER_KEY: "",
      })
    ).toBe(false);
  });

  it("every feature says what it needs", () => {
    for (const r of Object.values(FEATURE_REQUIREMENTS))
      expect(r.needs.length).toBeGreaterThan(10);
  });

  it("reads process.env by default", () => {
    expect(typeof isFeatureAvailable("speech_input")).toBe("boolean");
    expect(Object.keys(featureAvailability())).toHaveLength(4);
  });
});

describe("requireFeature", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("refuses an unconfigured feature with feature.not_configured (501)", async () => {
    delete process.env.SONG_ID_PROVIDER;
    const res = requireFeature("music_identification");
    expect(res?.status).toBe(501);
    const body = await res?.json();
    expect(body.code).toBe("feature.not_configured");
    expect(body.params).toEqual({ feature: "music_identification" });
  });

  it("lets a configured feature through", () => {
    expect(requireFeature("teams")).toBeNull();
  });
});

describe("GET /api/features", () => {
  it("returns booleans only, never a setting's value", async () => {
    const orig = { ...process.env };
    process.env = { ...orig, ...ACR, ...FFMPEG, GOOGLE_API_KEY: "secret-google-key" };
    try {
      const res = GET();
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
      const text = await res.text();
      expect(text).not.toMatch(/secret-google-key|ffmpeg\.example|"k"|"s"/);
      expect(JSON.parse(text).features.music_identification).toEqual({ available: true });
    } finally {
      process.env = { ...orig };
    }
  });
});
