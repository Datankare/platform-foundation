/**
 * Sprint 1a — Intent resolver tests
 *
 * Tests for IntentResolver interface and DefaultIntentResolver.
 *
 * 18-principle mapping: P1 P6 P7 P8 P11 P15 P17
 */

import {
  DefaultIntentResolver,
  type IntentResolver,
  type IntentContext,
  type ClassificationResult,
  type InputMode,
} from "@/platform/input";

// ── Helpers ───────────────────────────────────────────────────────────

function makeClassification(
  mode: InputMode,
  confidence: number = 1.0
): ClassificationResult {
  const classificationMap: Record<InputMode, ClassificationResult["classification"]> = {
    text: "text",
    speech: "speech",
    music: "music",
    file: "file",
  };
  return {
    classification: classificationMap[mode],
    confidence,
    mode,
    classifiedBy: "test",
    latencyMs: 0,
    cost: 0,
  };
}

function makeContext(overrides?: Partial<IntentContext>): IntentContext {
  return {
    currentMode: "text",
    hasText: false,
    isRecording: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DefaultIntentResolver
// ═══════════════════════════════════════════════════════════════════════

describe("DefaultIntentResolver", () => {
  let resolver: DefaultIntentResolver;

  beforeEach(() => {
    resolver = new DefaultIntentResolver();
  });

  it("has name 'default' (P15)", () => {
    expect(resolver.name).toBe("default");
  });

  it("implements IntentResolver interface (P7)", () => {
    const iface: IntentResolver = resolver;
    expect(typeof iface.resolve).toBe("function");
    expect(typeof iface.name).toBe("string");
  });

  // ── Text Mode ─────────────────────────────────────────────────────

  it("resolves text → process_text (P1)", async () => {
    const result = await resolver.resolve(makeClassification("text"), makeContext());
    expect(result.intent).toBe("process_text");
    expect(result.displayLabel).toBe("Process text");
  });

  // ── Speech Mode ───────────────────────────────────────────────────

  it("resolves speech → transcribe", async () => {
    const result = await resolver.resolve(
      makeClassification("speech"),
      makeContext({ currentMode: "speech" })
    );
    expect(result.intent).toBe("transcribe");
    expect(result.displayLabel).toBe("Transcribe speech");
  });

  // ── Music Mode ────────────────────────────────────────────────────

  it("resolves music → identify", async () => {
    const result = await resolver.resolve(
      makeClassification("music"),
      makeContext({ currentMode: "music" })
    );
    expect(result.intent).toBe("identify");
    expect(result.displayLabel).toBe("Identify audio");
  });

  // ── File Mode ─────────────────────────────────────────────────────

  it("resolves file → extract", async () => {
    const result = await resolver.resolve(
      makeClassification("file"),
      makeContext({ currentMode: "file" })
    );
    expect(result.intent).toBe("extract");
    expect(result.displayLabel).toBe("Extract content");
  });

  // ── Action Items (P6) ─────────────────────────────────────────────

  it("always returns Process as primary action", async () => {
    const modes: InputMode[] = ["text", "speech", "music", "file"];
    for (const mode of modes) {
      const result = await resolver.resolve(
        makeClassification(mode),
        makeContext({ currentMode: mode })
      );
      const primary = result.actions.filter((a) => a.primary);
      expect(primary).toHaveLength(1);
      expect(primary[0].id).toBe("process");
      expect(primary[0].label).toBe("Process");
    }
  });

  it("always includes Clear as non-primary action", async () => {
    const result = await resolver.resolve(makeClassification("text"), makeContext());
    const clear = result.actions.find((a) => a.id === "clear");
    expect(clear).toBeDefined();
    expect(clear!.primary).toBe(false);
    expect(clear!.label).toBe("Clear");
  });

  it("returns exactly 2 actions per mode", async () => {
    const modes: InputMode[] = ["text", "speech", "music", "file"];
    for (const mode of modes) {
      const result = await resolver.resolve(
        makeClassification(mode),
        makeContext({ currentMode: mode })
      );
      expect(result.actions).toHaveLength(2);
    }
  });

  // ── Confidence Passthrough ────────────────────────────────────────

  it("passes through classifier confidence", async () => {
    const result = await resolver.resolve(
      makeClassification("speech", 0.75),
      makeContext()
    );
    expect(result.confidence).toBe(0.75);
  });

  // ── Common Fields ─────────────────────────────────────────────────

  it("sets resolvedBy to 'default' (P15)", async () => {
    const result = await resolver.resolve(makeClassification("text"), makeContext());
    expect(result.resolvedBy).toBe("default");
  });

  it("sets cost to 0 (P12)", async () => {
    const result = await resolver.resolve(makeClassification("text"), makeContext());
    expect(result.cost).toBe(0);
  });

  it("records latencyMs (P3)", async () => {
    const result = await resolver.resolve(makeClassification("text"), makeContext());
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
