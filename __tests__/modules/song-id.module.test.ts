/**
 * __tests__/modules/song-id.module.test.ts — The song-id module's contributions (ADR-054)
 *
 * The module runs with exactly its declared dependency (audio-convert). Its provider slot builds
 * and stores the live provider (TASK-041) and is reset with the core's slots; its rule, goal,
 * consent and account-status feature and the music_identification feature join the core's
 * lists; its health probe wraps the live provider, cached because each check is billable (X-13).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req",
}));

import { AUDIO_CONVERT_MODULE } from "@/platform/voice/audio-convert-module";
import { SONG_ID_MODULE } from "@/platform/voice/song-id-module";
import { SONG_IDENTIFY_RULE } from "@/platform/voice/song-id";
import { isFeatureAvailable } from "@/platform/features/availability";
import { CachedHealthProbe } from "@/platform/observability/health";
import { runWithModules, restoreAppModules } from "../helpers/modules";

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
const KEYS = [...Object.keys(ACR), ...Object.keys(FFMPEG)];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.resetModules();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  runWithModules([AUDIO_CONVERT_MODULE, SONG_ID_MODULE]);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => restoreAppModules());

async function boot() {
  const registry = await import("@/platform/providers/registry");
  registry.resetProviders();
  const selections = registry.initProviders();
  const { logger } = jest.requireMock("@/lib/logger");
  const { getSongIdProvider } = await import("@/platform/voice/song-id");
  return {
    registry,
    selections,
    warn: logger.warn as jest.Mock,
    provider: getSongIdProvider(),
  };
}

describe("song-id module — registration", () => {
  it("depends on audio-convert, and is refused without it", () => {
    expect(SONG_ID_MODULE.dependsOn).toEqual(["audio-convert"]);
    expect(() => runWithModules([SONG_ID_MODULE])).toThrow(
      /module "song-id": depends on module "audio-convert", which is not registered/
    );
  });
});

describe("song-id module — provider slot (TASK-041)", () => {
  it("defaults to the mock provider", async () => {
    const { selections, provider } = await boot();
    expect(selections.songId).toBe("mock");
    expect(provider.name).toBe("mock");
  });

  it("stores the ACRCloud provider when it is selected and configured", async () => {
    Object.assign(process.env, ACR);
    const { selections, provider, warn } = await boot();
    expect(selections.songId).toBe("acrcloud");
    expect(provider.name).toBe("acrcloud");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("SONG_ID_PROVIDER"));
  });

  it.each(["ACRCLOUD_HOST", "ACRCLOUD_ACCESS_KEY", "ACRCLOUD_ACCESS_SECRET"])(
    "falls back to the mock and warns when %s is missing",
    async (missing) => {
      Object.assign(process.env, ACR);
      delete process.env[missing];
      const { provider, warn } = await boot();
      expect(provider.name).toBe("mock");
      expect(warn).toHaveBeenCalledWith(
        "SONG_ID_PROVIDER=acrcloud but ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, or ACRCLOUD_ACCESS_SECRET missing — song ID will fail"
      );
    }
  );

  it("is cleared by resetProviders with the core's slots", async () => {
    Object.assign(process.env, ACR);
    const { registry } = await boot();
    expect(registry.providerSingletonKeys()).toContain("platform.voice.songIdProvider");
    registry.resetProviders();
    const { hasSingleton } = await import("@/platform/kernel/singleton");
    expect(hasSingleton("platform.voice.songIdProvider")).toBe(false);
  });
});

describe("song-id module — vocabulary", () => {
  it("registers the SONG_IDENTIFY rule, which the core no longer has", async () => {
    const { listRateRules, getRateRule, DEFAULT_RULES } =
      await import("@/platform/rate-limit");
    expect(getRateRule("song:identify")).toEqual(SONG_IDENTIFY_RULE);
    expect(
      listRateRules()
        .map((r) => [r.value.id, r.moduleId])
        .pop()
    ).toEqual(["song:identify", "song-id"]);
    expect(Object.keys(DEFAULT_RULES)).not.toContain("SONG_IDENTIFY");
    runWithModules([]);
    expect(() => getRateRule("song:identify")).toThrow(/Unknown rate limit rule/);
  });

  it("adds the identify-song goal and the identify_song feature fallbacks", async () => {
    const { listAgentGoals } = await import("@/platform/agents/goals");
    const { consentFeatureFallback } = await import("@/platform/auth/coppa-gate");
    const { restrictedFeatureFallback } =
      await import("@/platform/auth/account-status-guard");
    expect(listAgentGoals()).toEqual(["analyze", "identify-song"]);
    expect(consentFeatureFallback()).toContain("identify_song");
    expect(restrictedFeatureFallback()).toContain("identify_song");
  });

  it("offers music identification only with ACRCloud and a converter that converts", () => {
    expect(isFeatureAvailable("music_identification", { ...ACR, ...FFMPEG })).toBe(true);
    expect(isFeatureAvailable("music_identification", ACR)).toBe(false);
    expect(isFeatureAvailable("music_identification", FFMPEG)).toBe(false);
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
    expect(
      isFeatureAvailable("music_identification", { ...FFMPEG, SONG_ID_PROVIDER: "mock" })
    ).toBe(false);
  });
});

describe("song-id module — health probe (TASK-041, X-13)", () => {
  it("wraps the live provider in a cached probe", async () => {
    await boot();
    const { createModuleHealthProbes } = await import("@/platform/modules/contributions");
    const probes = createModuleHealthProbes();
    expect(probes.map((p) => p.name)).toEqual(["song-identification"]);
    expect(probes[0]).toBeInstanceOf(CachedHealthProbe);
    const result = await probes[0].check();
    expect(result).toMatchObject({ name: "song-identification", status: "healthy" });
  });

  it("is not built for an app without the module", async () => {
    runWithModules([AUDIO_CONVERT_MODULE]);
    const { createModuleHealthProbes } = await import("@/platform/modules/contributions");
    expect(createModuleHealthProbes()).toEqual([]);
  });
});
