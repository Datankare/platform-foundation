/**
 * __tests__/modules/voice.module.test.ts — The voice module's contributions (ADR-054)
 *
 * The module runs in an app that registers it with exactly its declared dependencies
 * (translation, audio-convert). Its TTS and STT slots are selected and checked like core slots;
 * its goals, speech features, consent and account-status feature and content kind join the
 * core's lists. Registering it without a dependency is refused.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req",
}));

import { TRANSLATION_MODULE } from "@/platform/translation/module";
import { AUDIO_CONVERT_MODULE } from "@/platform/voice/audio-convert-module";
import { VOICE_MODULE } from "@/platform/voice/voice-module";
import {
  isFeatureAvailable,
  featureAvailability,
} from "@/platform/features/availability";
import { runWithModules, restoreAppModules } from "../helpers/modules";

const DEPENDENCIES = [TRANSLATION_MODULE, AUDIO_CONVERT_MODULE];
const KEYS = [
  "TTS_PROVIDER",
  "STT_PROVIDER",
  "GOOGLE_API_KEY",
  "NEXT_PUBLIC_GOOGLE_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};
const FFMPEG = {
  AUDIO_CONVERTER: "ffmpeg-service",
  AUDIO_CONVERTER_URL: "https://ffmpeg.example",
  AUDIO_CONVERTER_KEY: "key",
};

beforeEach(() => {
  jest.resetModules();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  runWithModules([...DEPENDENCIES, VOICE_MODULE]);
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
  return { selections, warn: logger.warn as jest.Mock };
}

describe("voice module — registration", () => {
  it("declares its dependencies", () => {
    expect(VOICE_MODULE.dependsOn).toEqual(["translation", "audio-convert"]);
  });

  it.each([
    ["translation", [AUDIO_CONVERT_MODULE, VOICE_MODULE]],
    ["audio-convert", [TRANSLATION_MODULE, VOICE_MODULE]],
  ])("is refused without %s", (missing, modules) => {
    expect(() => runWithModules(modules)).toThrow(
      new RegExp(
        `module "voice": depends on module "${missing}", which is not registered`
      )
    );
  });
});

describe("voice module — provider slots", () => {
  it("defaults both slots to mock", async () => {
    const { selections } = await boot();
    expect([selections.tts, selections.stt]).toEqual(["mock", "mock"]);
  });

  it.each([
    ["TTS_PROVIDER", "tts", "TTS will fail"],
    ["STT_PROVIDER", "stt", "STT will fail"],
  ])("%s=google without a key warns", async (envVar, slot, consequence) => {
    process.env[envVar] = "google";
    const { selections, warn } = await boot();
    expect(selections[slot]).toBe("google");
    expect(warn).toHaveBeenCalledWith(
      `${envVar}=google but GOOGLE_API_KEY missing — ${consequence}`
    );
  });

  it("does not warn when the key is set", async () => {
    process.env.TTS_PROVIDER = "google";
    process.env.STT_PROVIDER = "google";
    process.env.GOOGLE_API_KEY = "k";
    const { warn } = await boot();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_API_KEY missing")
    );
  });
});

describe("voice module — features", () => {
  it("offers speech input with a speech key, either spelling, ignoring blanks", () => {
    expect(isFeatureAvailable("speech_input", { GOOGLE_API_KEY: "g" })).toBe(true);
    expect(isFeatureAvailable("speech_input", { NEXT_PUBLIC_GOOGLE_API_KEY: "g" })).toBe(
      true
    );
    expect(isFeatureAvailable("speech_input", { GOOGLE_API_KEY: " " })).toBe(false);
    expect(isFeatureAvailable("speech_input", {})).toBe(false);
  });

  it("offers audio upload only with a speech key and a converter that converts", () => {
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
    expect(
      isFeatureAvailable("audio_upload", { GOOGLE_API_KEY: "g", AUDIO_CONVERTER: "mock" })
    ).toBe(false);
  });

  it("playform-dev today: speech input only (no converter)", () => {
    const env = { GOOGLE_API_KEY: "g", AUDIO_CONVERTER: "mock" };
    expect(isFeatureAvailable("speech_input", env)).toBe(true);
    expect(isFeatureAvailable("audio_upload", env)).toBe(false);
  });

  it("adds its features after the core's", () => {
    expect(Object.keys(featureAvailability({}))).toEqual([
      "sso_google",
      "sso_apple",
      "sso_microsoft",
      "audio_upload",
      "speech_input",
    ]);
  });
});

describe("voice module — vocabulary", () => {
  it("adds the speech goals", async () => {
    const { listAgentGoals } = await import("@/platform/agents/goals");
    expect(listAgentGoals()).toEqual([
      "analyze",
      "translate",
      "transcribe",
      "speak",
      "translate-and-speak",
      "full-pipeline",
    ]);
  });

  it("adds transcribe to the consent and account-status fallbacks", async () => {
    const { consentFeatureFallback } = await import("@/platform/auth/coppa-gate");
    const { restrictedFeatureFallback } =
      await import("@/platform/auth/account-status-guard");
    expect(consentFeatureFallback()).toContain("transcribe");
    expect(restrictedFeatureFallback()).toContain("transcribe");
  });

  it("adds the transcription content kind, with a governed severity reduction", async () => {
    const { allowsSeverityReduction } =
      await import("@/platform/moderation/content-types");
    expect(allowsSeverityReduction("transcription")).toBe(true);
    runWithModules(DEPENDENCIES);
    expect(allowsSeverityReduction("transcription")).toBe(false);
  });
});
