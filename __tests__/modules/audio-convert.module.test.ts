/**
 * __tests__/modules/audio-convert.module.test.ts — The audio-convert module (ADR-054)
 *
 * The module runs alone (it depends on nothing): its converter slot is selected and checked like
 * a core slot, and its readiness — what song identification and audio upload require — reads
 * the same settings.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req",
}));

import { AUDIO_CONVERT_MODULE } from "@/platform/voice/audio-convert-module";
import {
  AUDIO_CONVERTER_NEEDS,
  checkAudioConverterHealth,
  isAudioConverterReady,
  MockAudioConverter,
} from "@/platform/voice/audio-convert";
import { runWithModules, restoreAppModules } from "../helpers/modules";

const KEYS = ["AUDIO_CONVERTER", "AUDIO_CONVERTER_URL", "AUDIO_CONVERTER_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.resetModules();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  runWithModules([AUDIO_CONVERT_MODULE]);
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

describe("audio-convert module — provider slot", () => {
  it("declares the converter slot", () => {
    expect(AUDIO_CONVERT_MODULE.dependsOn).toEqual([]);
    expect(AUDIO_CONVERT_MODULE.providers[0]).toMatchObject({
      slot: "audioConverter",
      envVar: "AUDIO_CONVERTER",
      values: ["ffmpeg-service", "passthrough", "mock"],
      defaultValue: "mock",
    });
  });

  it("defaults to mock, and reads passthrough", async () => {
    expect((await boot()).selections.audioConverter).toBe("mock");
    process.env.AUDIO_CONVERTER = "passthrough";
    const { selections, warn } = await boot();
    expect(selections.audioConverter).toBe("passthrough");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("AUDIO_CONVERTER"));
  });

  it.each([
    [{}],
    [{ AUDIO_CONVERTER_URL: "https://ffmpeg.example" }],
    [{ AUDIO_CONVERTER_KEY: "key" }],
  ])("warns when the ffmpeg service lacks its settings (%o)", async (settings) => {
    process.env.AUDIO_CONVERTER = "ffmpeg-service";
    Object.assign(process.env, settings);
    const { warn } = await boot();
    expect(warn).toHaveBeenCalledWith(
      "AUDIO_CONVERTER=ffmpeg-service but AUDIO_CONVERTER_URL or AUDIO_CONVERTER_KEY missing — conversion will fail"
    );
  });

  it("does not warn when the ffmpeg service is configured", async () => {
    process.env.AUDIO_CONVERTER = "ffmpeg-service";
    process.env.AUDIO_CONVERTER_URL = "https://ffmpeg.example";
    process.env.AUDIO_CONVERTER_KEY = "key";
    const { warn } = await boot();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("AUDIO_CONVERTER"));
  });
});

describe("audio-convert module — readiness and health", () => {
  const FFMPEG = {
    AUDIO_CONVERTER: "ffmpeg-service",
    AUDIO_CONVERTER_URL: "https://ffmpeg.example",
    AUDIO_CONVERTER_KEY: "key",
  };

  it("is ready only with the ffmpeg service, its URL and its key", () => {
    expect(isAudioConverterReady(FFMPEG)).toBe(true);
    expect(isAudioConverterReady({ ...FFMPEG, AUDIO_CONVERTER: "passthrough" })).toBe(
      false
    );
    expect(isAudioConverterReady({ ...FFMPEG, AUDIO_CONVERTER_URL: " " })).toBe(false);
    expect(isAudioConverterReady({ ...FFMPEG, AUDIO_CONVERTER_KEY: undefined })).toBe(
      false
    );
    expect(isAudioConverterReady({})).toBe(false);
    expect(AUDIO_CONVERTER_NEEDS).toMatch(/AUDIO_CONVERTER=ffmpeg-service/);
  });

  it("reads process.env by default", () => {
    process.env.AUDIO_CONVERTER = "mock";
    expect(isAudioConverterReady()).toBe(false);
  });

  it("probes the converter: healthy, unreachable, or answering with an error", async () => {
    const converter = new MockAudioConverter();
    expect(await checkAudioConverterHealth(converter)).toMatchObject({
      provider: "mock",
      healthy: true,
    });
    converter.errorToThrow = new Error("connect ECONNREFUSED");
    expect(await checkAudioConverterHealth(converter)).toMatchObject({
      healthy: false,
      error: "connect ECONNREFUSED",
    });
    converter.errorToThrow = new Error("unsupported format");
    expect(await checkAudioConverterHealth(converter)).toMatchObject({
      healthy: true,
      error: undefined,
    });
  });
});
