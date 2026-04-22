/**
 * Phase 3 Sprint 4a — Song Identification + Audio Format Conversion Tests
 *
 * 18-principle mapping table verified before code:
 *   P1  ✅ orchestration     P2  ✅ instrumentation  P3  ✅ safety/privacy
 *   P5  ✅ cost tracking     P6  ✅ structured output P7  ✅ provider abstraction
 *   P9  ✅ observable         P10 ✅ testable          P11 ✅ graceful degradation
 *   P12 ✅ content safety     P13 ✅ rate limiting     P14 ✅ audit trail
 *   P15 ✅ agent identity     P16 ✅ cache interface   P17 ✅ intent mapping
 *   P18 ✅ trajectories
 */

import { MockSongIdentifier } from "@/platform/voice/mock-identify";
import { MockAudioConverter } from "@/platform/voice/mock-audio-converter";
import { PassthroughConverter } from "@/platform/voice/passthrough-converter";
import {
  checkSongIdHealth,
  checkAudioConverterHealth,
} from "@/platform/voice/health-probe";
import {
  CANONICAL_FORMAT,
  type SourceAudioFormat,
} from "@/platform/voice/audio-format-types";
import {
  IDENTIFY_INTENT,
  MIN_CLIP_SECONDS,
  MAX_CLIP_SECONDS,
  IDENTIFY_RATE_LIMIT_PER_HOUR,
  type SongMatch,
  type IdentifyCache,
} from "@/platform/voice/identify-types";

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: () => "test-req-1",
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function makeAudioBuffer(bytes: number = 500): Buffer {
  return Buffer.alloc(bytes, 0x42);
}

// ═══════════════════════════════════════════════════════════════════════
// CANONICAL FORMAT CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

describe("Canonical Format Constants", () => {
  it("defines WAV 16kHz mono 16-bit PCM", () => {
    expect(CANONICAL_FORMAT.format).toBe("wav");
    expect(CANONICAL_FORMAT.sampleRate).toBe(16000);
    expect(CANONICAL_FORMAT.channels).toBe(1);
    expect(CANONICAL_FORMAT.bitDepth).toBe(16);
    expect(CANONICAL_FORMAT.encoding).toBe("s16le");
    expect(CANONICAL_FORMAT.mimeType).toBe("audio/wav");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// IDENTIFY CONSTANTS (P13, P17)
// ═══════════════════════════════════════════════════════════════════════

describe("Identification Constants", () => {
  it("has minimum clip seconds", () => {
    expect(MIN_CLIP_SECONDS).toBe(3);
  });

  it("has maximum clip seconds", () => {
    expect(MAX_CLIP_SECONDS).toBe(15);
  });

  it("has rate limit per hour (P13)", () => {
    expect(IDENTIFY_RATE_LIMIT_PER_HOUR).toBe(10);
  });

  it("exports IDENTIFY_INTENT as 'inform' (P17)", () => {
    expect(IDENTIFY_INTENT).toBe("inform");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MOCK AUDIO CONVERTER
// ═══════════════════════════════════════════════════════════════════════

describe("MockAudioConverter", () => {
  let converter: MockAudioConverter;

  beforeEach(() => {
    converter = new MockAudioConverter();
  });

  it("has name 'mock'", () => {
    expect(converter.name).toBe("mock");
  });

  it("supports all source formats (P7)", () => {
    const formats: SourceAudioFormat[] = ["webm", "mp3", "ogg", "flac", "wav", "opus"];
    for (const fmt of formats) {
      expect(converter.supportsFormat(fmt)).toBe(true);
    }
    expect(converter.getSupportedFormats()).toEqual(expect.arrayContaining(formats));
  });

  it("converts non-WAV formats and marks converted=true", async () => {
    const result = await converter.convert({
      audioData: makeAudioBuffer(),
      sourceFormat: "webm",
    });
    expect(result.converted).toBe(true);
    expect(result.sourceFormat).toBe("webm");
    expect(result.audioData.length).toBeGreaterThan(0);
    expect(result.sourceSizeBytes).toBe(500);
  });

  it("passes through WAV with converted=false", async () => {
    const input = makeAudioBuffer(200);
    const result = await converter.convert({
      audioData: input,
      sourceFormat: "wav",
    });
    expect(result.converted).toBe(false);
    expect(result.audioData).toBe(input);
    expect(result.outputSizeBytes).toBe(200);
  });

  it("returns estimatedCostUsd = 0 (P5)", async () => {
    const result = await converter.convert({
      audioData: makeAudioBuffer(),
      sourceFormat: "mp3",
    });
    expect(result.estimatedCostUsd).toBe(0);
  });

  it("returns latencyMs in result (P2)", async () => {
    const result = await converter.convert({
      audioData: makeAudioBuffer(),
      sourceFormat: "mp3",
    });
    expect(typeof result.latencyMs).toBe("number");
  });

  it("throws injected error (P10)", async () => {
    converter.errorToThrow = new Error("test-convert-fail");
    await expect(
      converter.convert({ audioData: makeAudioBuffer(), sourceFormat: "webm" })
    ).rejects.toThrow("test-convert-fail");
  });

  it("tracks calls for assertions (P10)", async () => {
    await converter.convert({ audioData: makeAudioBuffer(), sourceFormat: "ogg" });
    await converter.convert({ audioData: makeAudioBuffer(), sourceFormat: "flac" });
    expect(converter.convertCalls).toHaveLength(2);
    expect(converter.convertCalls[0].sourceFormat).toBe("ogg");
    expect(converter.convertCalls[1].sourceFormat).toBe("flac");
  });

  it("handles empty buffer input", async () => {
    const result = await converter.convert({
      audioData: Buffer.alloc(0),
      sourceFormat: "webm",
    });
    expect(result.sourceSizeBytes).toBe(0);
    expect(result.converted).toBe(true);
  });

  it("resets state cleanly", () => {
    converter.errorToThrow = new Error("x");
    converter.simulatedLatencyMs = 100;
    converter.convertCalls.push({} as never);
    converter.reset();
    expect(converter.convertCalls).toHaveLength(0);
    expect(converter.errorToThrow).toBeNull();
    expect(converter.simulatedLatencyMs).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PASSTHROUGH CONVERTER
// ═══════════════════════════════════════════════════════════════════════

describe("PassthroughConverter", () => {
  let converter: PassthroughConverter;

  beforeEach(() => {
    converter = new PassthroughConverter();
  });

  it("has name 'passthrough'", () => {
    expect(converter.name).toBe("passthrough");
  });

  it("only supports WAV format", () => {
    expect(converter.supportsFormat("wav")).toBe(true);
    expect(converter.supportsFormat("webm")).toBe(false);
    expect(converter.supportsFormat("mp3")).toBe(false);
    expect(converter.getSupportedFormats()).toEqual(["wav"]);
  });

  it("passes WAV through unchanged", async () => {
    const input = makeAudioBuffer(300);
    const result = await converter.convert({ audioData: input, sourceFormat: "wav" });
    expect(result.converted).toBe(false);
    expect(result.audioData).toBe(input);
    expect(result.sourceSizeBytes).toBe(300);
    expect(result.outputSizeBytes).toBe(300);
    expect(result.estimatedCostUsd).toBe(0);
  });

  it("throws clear error for non-WAV formats (P11)", async () => {
    await expect(
      converter.convert({ audioData: makeAudioBuffer(), sourceFormat: "webm" })
    ).rejects.toThrow("PassthroughConverter only accepts WAV input");
  });

  it("throws for mp3", async () => {
    await expect(
      converter.convert({ audioData: makeAudioBuffer(), sourceFormat: "mp3" })
    ).rejects.toThrow("PassthroughConverter only accepts WAV");
  });

  it("handles zero-byte WAV input", async () => {
    const result = await converter.convert({
      audioData: Buffer.alloc(0),
      sourceFormat: "wav",
    });
    expect(result.converted).toBe(false);
    expect(result.outputSizeBytes).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MOCK SONG IDENTIFIER
// ═══════════════════════════════════════════════════════════════════════

describe("MockSongIdentifier", () => {
  let identifier: MockSongIdentifier;

  beforeEach(() => {
    identifier = new MockSongIdentifier();
  });

  it("has name 'mock'", () => {
    expect(identifier.name).toBe("mock");
  });

  // ── P1: All identification through provider ───────────────────────

  it("returns a match by default", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.matched).toBe(true);
    expect(result.match).not.toBeNull();
    expect(result.match?.title).toBe("Bohemian Rhapsody");
    expect(result.match?.artist).toBe("Queen");
    expect(result.provider).toBe("mock");
  });

  // ── P6: Structured output — SongMatch shape ──────────────────────

  it("returns complete SongMatch structure", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    const match = result.match!;
    expect(match.title).toBeDefined();
    expect(match.artist).toBeDefined();
    expect(match.album).toBeDefined();
    expect(match.confidence).toBeGreaterThan(0);
    expect(match.externalId).toBeDefined();
    expect(match.durationSeconds).toBeDefined();
    expect(Array.isArray(match.genres)).toBe(true);
  });

  // ── P5: Cost tracking ─────────────────────────────────────────────

  it("returns estimatedCostUsd = 0 (P5)", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.estimatedCostUsd).toBe(0);
  });

  // ── P17: Intent mapping ───────────────────────────────────────────

  it("returns intent 'inform' (P17)", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.intent).toBe("inform");
  });

  // ── P18: Trajectory context ───────────────────────────────────────

  it("passes through trajectoryId and stepIndex (P18)", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
      trajectoryId: "traj_123",
      stepIndex: 2,
    });
    expect(result.trajectoryId).toBe("traj_123");
    expect(result.stepIndex).toBe(2);
  });

  it("leaves trajectory fields undefined when not provided", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.trajectoryId).toBeUndefined();
    expect(result.stepIndex).toBeUndefined();
  });

  // ── P11: Graceful degradation ─────────────────────────────────────

  it("returns no match when forceNoMatch is set", async () => {
    identifier.forceNoMatch = true;
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.matched).toBe(false);
    expect(result.match).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("returns no match when matchToReturn is null", async () => {
    identifier.matchToReturn = null;
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.matched).toBe(false);
    expect(result.match).toBeNull();
  });

  // ── P9: Observable ────────────────────────────────────────────────

  it("propagates requestId from request", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
      requestId: "custom-req-42",
    });
    expect(result.requestId).toBe("custom-req-42");
  });

  it("generates requestId if not provided", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.requestId).toBe("test-req-1");
  });

  // ── P2: Instrumentation ───────────────────────────────────────────

  it("returns latencyMs and clipDurationSeconds", async () => {
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 7,
    });
    expect(typeof result.latencyMs).toBe("number");
    expect(result.clipDurationSeconds).toBe(7);
  });

  // ── P15: Agent identity ───────────────────────────────────────────

  it("accepts agentic context in request", async () => {
    await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
      actorType: "agent",
      actorId: "agent-007",
      onBehalfOf: "user-42",
    });
    expect(identifier.identifyCalls[0].actorType).toBe("agent");
    expect(identifier.identifyCalls[0].actorId).toBe("agent-007");
    expect(identifier.identifyCalls[0].onBehalfOf).toBe("user-42");
  });

  // ── P10: Testable ─────────────────────────────────────────────────

  it("throws injected error", async () => {
    identifier.errorToThrow = new Error("api-down");
    await expect(
      identifier.identify({ audioData: makeAudioBuffer(), durationSeconds: 10 })
    ).rejects.toThrow("api-down");
  });

  it("tracks calls for assertions", async () => {
    await identifier.identify({ audioData: makeAudioBuffer(100), durationSeconds: 5 });
    await identifier.identify({ audioData: makeAudioBuffer(200), durationSeconds: 10 });
    expect(identifier.identifyCalls).toHaveLength(2);
  });

  it("allows custom match override", async () => {
    const custom: SongMatch = { title: "Custom", artist: "Artist", confidence: 80 };
    identifier.matchToReturn = custom;
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.match?.title).toBe("Custom");
  });

  it("allows confidence override", async () => {
    identifier.confidenceOverride = 42;
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.confidence).toBe(42);
  });

  it("resets all state", () => {
    identifier.forceNoMatch = true;
    identifier.errorToThrow = new Error("x");
    identifier.confidenceOverride = 50;
    identifier.identifyCalls.push({} as never);
    identifier.reset();
    expect(identifier.identifyCalls).toHaveLength(0);
    expect(identifier.errorToThrow).toBeNull();
    expect(identifier.matchToReturn).not.toBeNull();
    expect(identifier.confidenceOverride).toBeNull();
    expect(identifier.forceNoMatch).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// P16: IdentifyCache interface
// ═══════════════════════════════════════════════════════════════════════

describe("IdentifyCache interface (P16)", () => {
  it("can be implemented as an in-memory cache", async () => {
    const store = new Map<
      string,
      import("@/platform/voice/identify-types").IdentifyResult
    >();

    const cache: IdentifyCache = {
      async get(audioHash) {
        return store.get(audioHash) ?? null;
      },
      async set(audioHash, result) {
        store.set(audioHash, result);
      },
    };

    // Miss
    expect(await cache.get("hash-1")).toBeNull();

    // Set + hit
    const mockResult = {
      match: null,
      matched: false,
      confidence: 0,
      latencyMs: 100,
      provider: "mock",
      requestId: "r-1",
      clipDurationSeconds: 10,
      estimatedCostUsd: 0.01,
      intent: IDENTIFY_INTENT,
    } satisfies import("@/platform/voice/identify-types").IdentifyResult;

    await cache.set("hash-1", mockResult);
    const hit = await cache.get("hash-1");
    expect(hit).not.toBeNull();
    expect(hit?.requestId).toBe("r-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ACRCLOUD IDENTIFIER — config validation (no real API calls)
// ═══════════════════════════════════════════════════════════════════════

describe("ACRCloudIdentifier — config validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws when ACRCLOUD_HOST is not configured", async () => {
    delete process.env.ACRCLOUD_HOST;
    delete process.env.ACRCLOUD_ACCESS_KEY;
    delete process.env.ACRCLOUD_ACCESS_SECRET;

    const { ACRCloudIdentifier } = await import("@/platform/voice/acrcloud-identify");
    const id = new ACRCloudIdentifier();
    await expect(
      id.identify({ audioData: makeAudioBuffer(), durationSeconds: 10 })
    ).rejects.toThrow("ACRCloud not configured");
  });

  it("throws when audio clip is too short", async () => {
    process.env.ACRCLOUD_HOST = "test.acrcloud.com";
    process.env.ACRCLOUD_ACCESS_KEY = "key";
    process.env.ACRCLOUD_ACCESS_SECRET = "secret";

    const { ACRCloudIdentifier } = await import("@/platform/voice/acrcloud-identify");
    const id = new ACRCloudIdentifier();
    await expect(
      id.identify({ audioData: makeAudioBuffer(), durationSeconds: 1 })
    ).rejects.toThrow("Audio clip too short");
  });

  it("throws when audio data is empty", async () => {
    process.env.ACRCLOUD_HOST = "test.acrcloud.com";
    process.env.ACRCLOUD_ACCESS_KEY = "key";
    process.env.ACRCLOUD_ACCESS_SECRET = "secret";

    const { ACRCloudIdentifier } = await import("@/platform/voice/acrcloud-identify");
    const id = new ACRCloudIdentifier();
    await expect(
      id.identify({ audioData: Buffer.alloc(0), durationSeconds: 10 })
    ).rejects.toThrow("Audio data is empty");
  });

  it("throws for clip at exactly MIN_CLIP_SECONDS - 1", async () => {
    process.env.ACRCLOUD_HOST = "test.acrcloud.com";
    process.env.ACRCLOUD_ACCESS_KEY = "key";
    process.env.ACRCLOUD_ACCESS_SECRET = "secret";

    const { ACRCloudIdentifier } = await import("@/platform/voice/acrcloud-identify");
    const id = new ACRCloudIdentifier();
    await expect(
      id.identify({ audioData: makeAudioBuffer(), durationSeconds: MIN_CLIP_SECONDS - 1 })
    ).rejects.toThrow("Audio clip too short");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// FFMPEG SERVICE CONVERTER — config validation (no real API calls)
// ═══════════════════════════════════════════════════════════════════════

describe("FfmpegServiceConverter — config validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws when AUDIO_CONVERTER_URL is not configured", async () => {
    delete process.env.AUDIO_CONVERTER_URL;
    delete process.env.AUDIO_CONVERTER_KEY;

    const { FfmpegServiceConverter } = await import("@/platform/voice/ffmpeg-converter");
    const c = new FfmpegServiceConverter();
    await expect(
      c.convert({ audioData: makeAudioBuffer(), sourceFormat: "webm" })
    ).rejects.toThrow("AUDIO_CONVERTER_URL not configured");
  });

  it("throws when AUDIO_CONVERTER_KEY is not configured", async () => {
    process.env.AUDIO_CONVERTER_URL = "https://ffmpeg.test.com";
    delete process.env.AUDIO_CONVERTER_KEY;

    const { FfmpegServiceConverter } = await import("@/platform/voice/ffmpeg-converter");
    const c = new FfmpegServiceConverter();
    await expect(
      c.convert({ audioData: makeAudioBuffer(), sourceFormat: "webm" })
    ).rejects.toThrow("AUDIO_CONVERTER_KEY not configured");
  });

  it("throws when audio exceeds 10MB limit", async () => {
    process.env.AUDIO_CONVERTER_URL = "https://ffmpeg.test.com";
    process.env.AUDIO_CONVERTER_KEY = "test-key";

    const { FfmpegServiceConverter } = await import("@/platform/voice/ffmpeg-converter");
    const c = new FfmpegServiceConverter();
    await expect(
      c.convert({ audioData: Buffer.alloc(11 * 1024 * 1024), sourceFormat: "webm" })
    ).rejects.toThrow("Audio exceeds maximum size");
  });

  it("throws for unsupported format", async () => {
    process.env.AUDIO_CONVERTER_URL = "https://ffmpeg.test.com";
    process.env.AUDIO_CONVERTER_KEY = "test-key";

    const { FfmpegServiceConverter } = await import("@/platform/voice/ffmpeg-converter");
    const c = new FfmpegServiceConverter();
    await expect(
      c.convert({
        audioData: makeAudioBuffer(),
        sourceFormat: "aac" as SourceAudioFormat,
      })
    ).rejects.toThrow("Unsupported source format");
  });

  it("supports all expected formats", async () => {
    process.env.AUDIO_CONVERTER_URL = "https://ffmpeg.test.com";
    process.env.AUDIO_CONVERTER_KEY = "test-key";

    const { FfmpegServiceConverter } = await import("@/platform/voice/ffmpeg-converter");
    const c = new FfmpegServiceConverter();
    const expected: SourceAudioFormat[] = ["webm", "mp3", "ogg", "flac", "wav", "opus"];
    for (const fmt of expected) {
      expect(c.supportsFormat(fmt)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// HEALTH PROBES (Sprint 4a additions)
// ═══════════════════════════════════════════════════════════════════════

describe("Health Probes — Song ID", () => {
  it("reports healthy when provider responds", async () => {
    const provider = new MockSongIdentifier();
    const status = await checkSongIdHealth(provider);
    expect(status.healthy).toBe(true);
    expect(status.provider).toBe("mock");
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.error).toBeUndefined();
  });

  it("reports healthy on non-connectivity errors", async () => {
    const provider = new MockSongIdentifier();
    provider.errorToThrow = new Error("invalid audio format");
    const status = await checkSongIdHealth(provider);
    expect(status.healthy).toBe(true);
    expect(status.error).toBeUndefined();
  });

  it("reports unhealthy on connectivity errors", async () => {
    const provider = new MockSongIdentifier();
    provider.errorToThrow = new Error("ECONNREFUSED");
    const status = await checkSongIdHealth(provider);
    expect(status.healthy).toBe(false);
    expect(status.error).toContain("ECONNREFUSED");
  });
});

describe("Health Probes — Audio Converter", () => {
  it("reports healthy when converter responds", async () => {
    const converter = new MockAudioConverter();
    const status = await checkAudioConverterHealth(converter);
    expect(status.healthy).toBe(true);
    expect(status.provider).toBe("mock");
    expect(status.error).toBeUndefined();
  });

  it("reports unhealthy on connectivity errors", async () => {
    const converter = new MockAudioConverter();
    converter.errorToThrow = new Error("fetch failed");
    const status = await checkAudioConverterHealth(converter);
    expect(status.healthy).toBe(false);
    expect(status.error).toContain("fetch failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// REGISTRY — New provider slots
// ═══════════════════════════════════════════════════════════════════════

describe("Registry — Sprint 4a provider slots", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("includes songId and audioConverter in provider selections", async () => {
    const { getActiveProviders } = await import("@/platform/providers/registry");
    const providers = getActiveProviders();
    expect(providers.songId).toBeDefined();
    expect(providers.audioConverter).toBeDefined();
  });

  it("defaults songId to mock", async () => {
    delete process.env.SONG_ID_PROVIDER;
    const { getActiveProviders } = await import("@/platform/providers/registry");
    expect(getActiveProviders().songId).toBe("mock");
  });

  it("defaults audioConverter to mock", async () => {
    delete process.env.AUDIO_CONVERTER;
    const { getActiveProviders } = await import("@/platform/providers/registry");
    expect(getActiveProviders().audioConverter).toBe("mock");
  });

  it("reads SONG_ID_PROVIDER from env", async () => {
    process.env.SONG_ID_PROVIDER = "acrcloud";
    const { getActiveProviders } = await import("@/platform/providers/registry");
    expect(getActiveProviders().songId).toBe("acrcloud");
  });

  it("reads AUDIO_CONVERTER from env", async () => {
    process.env.AUDIO_CONVERTER = "ffmpeg-service";
    const { getActiveProviders } = await import("@/platform/providers/registry");
    expect(getActiveProviders().audioConverter).toBe("ffmpeg-service");
  });

  it("reads passthrough for AUDIO_CONVERTER", async () => {
    process.env.AUDIO_CONVERTER = "passthrough";
    const { getActiveProviders } = await import("@/platform/providers/registry");
    expect(getActiveProviders().audioConverter).toBe("passthrough");
  });

  it("has 11 provider slots total", async () => {
    const { getActiveProviders } = await import("@/platform/providers/registry");
    expect(Object.keys(getActiveProviders())).toHaveLength(11);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RATE LIMIT RULE (P13)
// ═══════════════════════════════════════════════════════════════════════

describe("Rate Limit — SONG_IDENTIFY rule (P13)", () => {
  it("has SONG_IDENTIFY in DEFAULT_RULES", async () => {
    const { DEFAULT_RULES } = await import("@/platform/rate-limit");
    expect(DEFAULT_RULES.SONG_IDENTIFY).toBeDefined();
    expect(DEFAULT_RULES.SONG_IDENTIFY.id).toBe("song:identify");
    expect(DEFAULT_RULES.SONG_IDENTIFY.maxRequests).toBe(10);
    expect(DEFAULT_RULES.SONG_IDENTIFY.windowSeconds).toBe(3600);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION: Convert → Identify flow
// ═══════════════════════════════════════════════════════════════════════

describe("Integration: Convert → Identify", () => {
  it("converts audio then identifies song with full context", async () => {
    const converter = new MockAudioConverter();
    const identifier = new MockSongIdentifier();

    const convResult = await converter.convert({
      audioData: makeAudioBuffer(1000),
      sourceFormat: "webm",
      requestId: "integ-1",
    });
    expect(convResult.converted).toBe(true);
    expect(convResult.estimatedCostUsd).toBe(0);

    const idResult = await identifier.identify({
      audioData: convResult.audioData,
      durationSeconds: 10,
      requestId: "integ-1",
      actorType: "user",
      actorId: "user-123",
      trajectoryId: "traj_integ-1",
      stepIndex: 1,
    });
    expect(idResult.matched).toBe(true);
    expect(idResult.match?.title).toBe("Bohemian Rhapsody");
    expect(idResult.requestId).toBe("integ-1");
    expect(idResult.intent).toBe("inform");
    expect(idResult.trajectoryId).toBe("traj_integ-1");
    expect(idResult.stepIndex).toBe(1);
    expect(idResult.estimatedCostUsd).toBe(0);
  });

  it("handles conversion failure gracefully", async () => {
    const converter = new MockAudioConverter();
    converter.errorToThrow = new Error("conversion-failed");

    await expect(
      converter.convert({ audioData: makeAudioBuffer(), sourceFormat: "webm" })
    ).rejects.toThrow("conversion-failed");
  });

  it("handles identification failure gracefully", async () => {
    const converter = new MockAudioConverter();
    const identifier = new MockSongIdentifier();
    identifier.errorToThrow = new Error("provider-down");

    const convResult = await converter.convert({
      audioData: makeAudioBuffer(),
      sourceFormat: "mp3",
    });

    await expect(
      identifier.identify({ audioData: convResult.audioData, durationSeconds: 10 })
    ).rejects.toThrow("provider-down");
  });

  it("handles no-match without error (P11)", async () => {
    const converter = new MockAudioConverter();
    const identifier = new MockSongIdentifier();
    identifier.forceNoMatch = true;

    const convResult = await converter.convert({
      audioData: makeAudioBuffer(),
      sourceFormat: "ogg",
    });

    const idResult = await identifier.identify({
      audioData: convResult.audioData,
      durationSeconds: 8,
    });
    expect(idResult.matched).toBe(false);
    expect(idResult.match).toBeNull();
    expect(idResult.confidence).toBe(0);
    expect(idResult.intent).toBe("inform");
  });

  it("zero-confidence match returns matched=true with confidence=0", async () => {
    const identifier = new MockSongIdentifier();
    identifier.confidenceOverride = 0;
    const result = await identifier.identify({
      audioData: makeAudioBuffer(),
      durationSeconds: 10,
    });
    expect(result.matched).toBe(true);
    expect(result.match).not.toBeNull();
    expect(result.confidence).toBe(0);
  });
});
