/**
 * Phase 3 Sprint 3 — Voice Pipeline + Agentic Compliance Tests
 *
 * 18-principle mapping table verified before code:
 *   P1 ✅ orchestration   P2 ✅ metrics      P3 ✅ safety
 *   P5 ✅ cost tracking   P7 ✅ providers    P9 ✅ trace context
 *   P10 ✅ testable       P11 ✅ degradation  P14 ✅ audit trail
 *   P15 ✅ agent identity  P16 ✅ cache       P17 ✅ intents
 *   P18 ✅ trajectories
 */

import { VoicePipeline } from "@/platform/voice/pipeline";
import { MockTTSProvider, MockSTTProvider } from "@/platform/voice/mock-voice";
import { MockTranslateProvider } from "@/platform/translation/mock-translate";
import type {
  SafetyScreenFn,
  TranslationCache,
  PipelineMetricEvent,
} from "@/platform/voice/pipeline";

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  generateRequestId: () => "pipe-req-1",
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function createPipeline(overrides?: {
  safetyScreen?: SafetyScreenFn;
  stt?: MockSTTProvider;
  tts?: MockTTSProvider;
  translation?: MockTranslateProvider;
  translationCache?: TranslationCache;
  onMetric?: (event: PipelineMetricEvent) => void;
}) {
  return new VoicePipeline({
    stt: overrides?.stt ?? new MockSTTProvider(),
    tts: overrides?.tts ?? new MockTTSProvider(),
    translation: overrides?.translation ?? new MockTranslateProvider(),
    safetyScreen: overrides?.safetyScreen,
    translationCache: overrides?.translationCache,
    onMetric: overrides?.onMetric,
  });
}

const safePasser: SafetyScreenFn = async () => ({ safe: true });
const safetyBlocker: SafetyScreenFn = async () => ({
  safe: false,
  reason: "Content not allowed",
});

function createMockCache(): TranslationCache & {
  store: Map<string, string>;
  getCount: number;
  setCount: number;
} {
  const store = new Map<string, string>();
  const cache = {
    store,
    getCount: 0,
    setCount: 0,
    get: async (text: string, targetLang: string) => {
      cache.getCount++;
      return store.get(`${text}:${targetLang}`) ?? null;
    },
    set: async (text: string, targetLang: string, result: string) => {
      cache.setCount++;
      store.set(`${text}:${targetLang}`, result);
    },
  };
  return cache;
}

// ── Full Pipeline (text → translate → TTS) ──────────────────────────────

describe("VoicePipeline — text input", () => {
  it("translates and synthesizes text", async () => {
    const pipeline = createPipeline({ safetyScreen: safePasser });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: true,
      actorType: "user",
      actorId: "user-123",
    });

    expect(result.success).toBe(true);
    expect(result.transcript).toBe("Hello");
    expect(result.safetyPassed).toBe(true);
    expect(result.translation?.text).toBe("[MOCK:es] Hello");
    expect(result.tts?.audioContent).toBeTruthy();
    expect(result.steps).toHaveLength(4);
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.requestId).toBeTruthy();
  });

  it("skips TTS when synthesize=false", async () => {
    const pipeline = createPipeline({ safetyScreen: safePasser });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: false,
    });

    expect(result.success).toBe(true);
    expect(result.translation?.text).toBe("[MOCK:es] Hello");
    expect(result.tts).toBeUndefined();
    const ttsStep = result.steps.find((s) => s.step === "tts");
    expect(ttsStep?.status).toBe("skipped");
  });
});

// ── Full Pipeline (audio → STT → translate → TTS) ──────────────────────

describe("VoicePipeline — audio input", () => {
  it("transcribes, translates, and synthesizes", async () => {
    const pipeline = createPipeline({ safetyScreen: safePasser });
    const audio = Buffer.from("Hello world").toString("base64");

    const result = await pipeline.execute({
      audioBase64: audio,
      targetLanguage: "fr",
      synthesize: true,
    });

    expect(result.success).toBe(true);
    expect(result.transcript).toBe("Hello world");
    expect(result.translation?.text).toBe("[MOCK:fr] Hello world");
    expect(result.tts?.audioContent).toBeTruthy();

    const sttStep = result.steps.find((s) => s.step === "stt");
    expect(sttStep?.status).toBe("success");
  });
});

// ── P15: Agent Identity ─────────────────────────────────────────────────

describe("VoicePipeline — P15 Agent Identity", () => {
  it("propagates actorType and actorId to result", async () => {
    const pipeline = createPipeline();

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      actorType: "agent",
      actorId: "agent-42",
      onBehalfOf: "user-123",
    });

    expect(result.actorType).toBe("agent");
    expect(result.actorId).toBe("agent-42");
    expect(result.onBehalfOf).toBe("user-123");
  });

  it("defaults to user/anonymous when not specified", async () => {
    const pipeline = createPipeline();

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
    });

    expect(result.actorType).toBe("user");
    expect(result.actorId).toBe("anonymous");
  });

  it("includes actorType/actorId in metric events", async () => {
    const metrics: PipelineMetricEvent[] = [];
    const pipeline = createPipeline({ onMetric: (e) => metrics.push(e) });

    await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      actorType: "agent",
      actorId: "agent-7",
    });

    expect(metrics.length).toBeGreaterThan(0);
    for (const m of metrics) {
      expect(m.actorType).toBe("agent");
      expect(m.actorId).toBe("agent-7");
    }
  });
});

// ── P16: Translation Cache ──────────────────────────────────────────────

describe("VoicePipeline — P16 Translation Cache", () => {
  it("checks cache before calling provider", async () => {
    const cache = createMockCache();
    cache.store.set("Hello:es", "Hola (cached)");

    const translation = new MockTranslateProvider();
    const pipeline = createPipeline({
      translationCache: cache,
      translation,
    });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: false,
    });

    expect(result.translation?.text).toBe("Hola (cached)");
    expect(result.translation?.cached).toBe(true);
    expect(result.translationCached).toBe(true);
    expect(translation.callCount).toBe(0); // provider never called
    expect(cache.getCount).toBe(1);
  });

  it("stores result in cache on miss", async () => {
    const cache = createMockCache();
    const pipeline = createPipeline({ translationCache: cache });

    await pipeline.execute({
      text: "Hello",
      targetLanguage: "fr",
      synthesize: false,
    });

    expect(cache.setCount).toBe(1);
    expect(cache.store.get("Hello:fr")).toBe("[MOCK:fr] Hello");
  });

  it("works without cache (no crash)", async () => {
    const pipeline = createPipeline(); // no cache

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: false,
    });

    expect(result.success).toBe(true);
    expect(result.translationCached).toBe(false);
  });

  it("gracefully handles cache set failure", async () => {
    const cache = createMockCache();
    cache.set = jest.fn().mockRejectedValue(new Error("Redis down"));

    const pipeline = createPipeline({ translationCache: cache });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: false,
    });

    // Pipeline succeeds despite cache failure
    expect(result.success).toBe(true);
    expect(result.translation?.text).toBe("[MOCK:es] Hello");
  });
});

// ── P17: Cognition-Commitment Intents ───────────────────────────────────

describe("VoicePipeline — P17 Intents", () => {
  it("maps steps to correct intents", async () => {
    const pipeline = createPipeline({ safetyScreen: safePasser });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: true,
    });

    const intents = result.steps.map((s) => ({ step: s.step, intent: s.intent }));
    expect(intents).toEqual([
      { step: "stt", intent: "inform" },
      { step: "safety", intent: "checkpoint" },
      { step: "translate", intent: "propose" },
      { step: "tts", intent: "commit" },
    ]);
  });
});

// ── P18: Durable Trajectories ───────────────────────────────────────────

describe("VoicePipeline — P18 Trajectories", () => {
  it("all steps share same trajectoryId", async () => {
    const pipeline = createPipeline({ safetyScreen: safePasser });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: true,
    });

    const trajectoryId = result.trajectoryId;
    expect(trajectoryId).toBeTruthy();
    expect(trajectoryId.startsWith("traj_")).toBe(true);

    for (const step of result.steps) {
      expect(step.trajectoryId).toBe(trajectoryId);
    }
  });

  it("steps have incrementing stepIndex", async () => {
    const pipeline = createPipeline({ safetyScreen: safePasser });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: true,
    });

    const indices = result.steps.map((s) => s.stepIndex);
    expect(indices).toEqual([0, 1, 2, 3]);
  });

  it("trajectoryId appears in metric events", async () => {
    const metrics: PipelineMetricEvent[] = [];
    const pipeline = createPipeline({
      safetyScreen: safePasser,
      onMetric: (e) => metrics.push(e),
    });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: true,
    });

    for (const m of metrics) {
      expect(m.trajectoryId).toBe(result.trajectoryId);
    }
  });
});

// ── P2: Metrics Emission ────────────────────────────────────────────────

describe("VoicePipeline — P2 Metrics", () => {
  it("emits metric for every step", async () => {
    const metrics: PipelineMetricEvent[] = [];
    const pipeline = createPipeline({
      safetyScreen: safePasser,
      onMetric: (e) => metrics.push(e),
    });

    await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: true,
    });

    expect(metrics).toHaveLength(4);
    expect(metrics.map((m) => m.step)).toEqual(["stt", "safety", "translate", "tts"]);

    for (const m of metrics) {
      expect(m).toHaveProperty("intent");
      expect(m).toHaveProperty("latencyMs");
      expect(m).toHaveProperty("success");
      expect(m).toHaveProperty("traceId");
      expect(m).toHaveProperty("trajectoryId");
      expect(m).toHaveProperty("stepIndex");
    }
  });

  it("marks cached translation in metrics", async () => {
    const cache = createMockCache();
    cache.store.set("Hello:es", "Hola");

    const metrics: PipelineMetricEvent[] = [];
    const pipeline = createPipeline({
      translationCache: cache,
      onMetric: (e) => metrics.push(e),
    });

    await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: false,
    });

    const translateMetric = metrics.find((m) => m.step === "translate");
    expect(translateMetric?.cached).toBe(true);
  });
});

// ── P9: Trace Context ───────────────────────────────────────────────────

describe("VoicePipeline — P9 Trace Context", () => {
  it("propagates provided traceId to metrics", async () => {
    const metrics: PipelineMetricEvent[] = [];
    const pipeline = createPipeline({ onMetric: (e) => metrics.push(e) });

    await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      traceId: "trace-abc-123",
    });

    for (const m of metrics) {
      expect(m.traceId).toBe("trace-abc-123");
    }
  });

  it("auto-generates traceId when not provided", async () => {
    const metrics: PipelineMetricEvent[] = [];
    const pipeline = createPipeline({ onMetric: (e) => metrics.push(e) });

    await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
    });

    for (const m of metrics) {
      expect(m.traceId).toBeTruthy();
    }
  });
});

// ── Safety Screening (P3) ───────────────────────────────────────────────

describe("VoicePipeline — P3 Safety", () => {
  it("blocks unsafe content", async () => {
    const pipeline = createPipeline({ safetyScreen: safetyBlocker });

    const result = await pipeline.execute({
      text: "bad content",
      targetLanguage: "es",
    });

    expect(result.success).toBe(false);
    expect(result.safetyPassed).toBe(false);
    expect(result.safetyReason).toBe("Content not allowed");
    expect(result.transcript).toBe("bad content");
    expect(result.translation).toBeUndefined();
  });

  it("skips safety when no screen configured", async () => {
    const pipeline = createPipeline();

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
    });

    expect(result.success).toBe(true);
    expect(result.safetyPassed).toBe(true);
    const safetyStep = result.steps.find((s) => s.step === "safety");
    expect(safetyStep?.status).toBe("skipped");
  });

  it("blocks on safety error — fail closed (P3)", async () => {
    const failingSafety: SafetyScreenFn = async () => {
      throw new Error("safety service down");
    };
    const pipeline = createPipeline({ safetyScreen: failingSafety });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
    });

    expect(result.success).toBe(false);
    expect(result.safetyPassed).toBe(false);
    expect(result.safetyReason).toContain("safety service down");
  });
});

// ── P11: Partial Failures ───────────────────────────────────────────────

describe("VoicePipeline — P11 Partial Failures", () => {
  it("returns transcript when translation fails", async () => {
    const failingTranslation = new MockTranslateProvider();
    failingTranslation.translate = jest
      .fn()
      .mockRejectedValue(new Error("Google Translate API error: 503"));

    const pipeline = createPipeline({
      safetyScreen: safePasser,
      translation: failingTranslation,
    });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
    });

    expect(result.success).toBe(true);
    expect(result.transcript).toBe("Hello");
    expect(result.translation).toBeUndefined();

    const translateStep = result.steps.find((s) => s.step === "translate");
    expect(translateStep?.status).toBe("failed");
  });

  it("returns transcript + translation when TTS fails", async () => {
    const failingTTS = new MockTTSProvider();
    failingTTS.synthesize = jest
      .fn()
      .mockRejectedValue(new Error("Google TTS API error: 429"));

    const pipeline = createPipeline({
      safetyScreen: safePasser,
      tts: failingTTS,
    });

    const result = await pipeline.execute({
      text: "Hello",
      targetLanguage: "es",
      synthesize: true,
    });

    expect(result.success).toBe(true);
    expect(result.transcript).toBe("Hello");
    expect(result.translation?.text).toBe("[MOCK:es] Hello");
    expect(result.tts).toBeUndefined();
  });

  it("fails completely when STT fails", async () => {
    const failingSTT = new MockSTTProvider();
    failingSTT.transcribe = jest
      .fn()
      .mockRejectedValue(new Error("STT service unavailable"));

    const pipeline = createPipeline({ stt: failingSTT });
    const audio = Buffer.from("test").toString("base64");

    const result = await pipeline.execute({
      audioBase64: audio,
      targetLanguage: "es",
    });

    expect(result.success).toBe(false);
    expect(result.transcript).toBeUndefined();
  });

  it("fails when no audio or text provided", async () => {
    const pipeline = createPipeline();

    const result = await pipeline.execute({ targetLanguage: "es" });

    expect(result.success).toBe(false);
    expect(result.steps[0].error).toContain("No audio or text provided");
  });

  it("fails when STT returns empty transcript", async () => {
    const emptySTT = new MockSTTProvider();
    emptySTT.transcribe = jest.fn().mockResolvedValue({
      transcript: "",
      confidence: 0,
      languageCode: "en-US",
      latencyMs: 1,
    });

    const pipeline = createPipeline({ stt: emptySTT });
    const audio = Buffer.from("silence").toString("base64");

    const result = await pipeline.execute({
      audioBase64: audio,
      targetLanguage: "es",
    });

    expect(result.success).toBe(false);
    const sttStep = result.steps.find((s) => s.step === "stt");
    expect(sttStep?.error).toContain("No speech detected");
  });
});

// ── Health Probes ───────────────────────────────────────────────────────

describe("Voice Health Probes", () => {
  it("checkTranslationHealth returns healthy for mock", async () => {
    const { checkTranslationHealth } = await import("@/platform/voice/health-probe");
    const result = await checkTranslationHealth(new MockTranslateProvider());
    expect(result.healthy).toBe(true);
    expect(result.provider).toBe("mock");
  });

  it("checkTTSHealth returns healthy for mock", async () => {
    const { checkTTSHealth } = await import("@/platform/voice/health-probe");
    const result = await checkTTSHealth(new MockTTSProvider());
    expect(result.healthy).toBe(true);
  });

  it("checkSTTHealth returns healthy for mock", async () => {
    const { checkSTTHealth } = await import("@/platform/voice/health-probe");
    const result = await checkSTTHealth(new MockSTTProvider());
    expect(result.healthy).toBe(true);
  });

  it("reports unhealthy on provider error", async () => {
    const { checkTranslationHealth } = await import("@/platform/voice/health-probe");
    const broken = new MockTranslateProvider();
    broken.translate = jest.fn().mockRejectedValue(new Error("API down"));

    const result = await checkTranslationHealth(broken);
    expect(result.healthy).toBe(false);
    expect(result.error).toContain("API down");
  });
});

// ── Module exports ──────────────────────────────────────────────────────

describe("Voice module exports — Sprint 3 additions", () => {
  it("exports pipeline and health probes", async () => {
    const mod = await import("@/platform/voice/index");

    expect(mod.VoicePipeline).toBeDefined();
    expect(mod.checkTranslationHealth).toBeDefined();
    expect(mod.checkTTSHealth).toBeDefined();
    expect(mod.checkSTTHealth).toBeDefined();
  });
});
