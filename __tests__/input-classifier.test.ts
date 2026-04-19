/**
 * Sprint 1a — Input classifier tests
 *
 * Tests for InputClassifier interface, RuleBasedClassifier, and classificationToMode.
 *
 * 18-principle mapping: P6 P7 P11 P15 P17
 */

import {
  RuleBasedClassifier,
  classificationToMode,
  type InputClassifier,
  type InputEvent,
  type ContentClassification,
  type InputMode,
} from "@/platform/input";

// ── Helpers ───────────────────────────────────────────────────────────

function makeEvent(
  type: InputEvent["type"],
  overrides?: Partial<InputEvent>
): InputEvent {
  return {
    type,
    timestamp: "2026-04-19T10:00:00Z",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// classificationToMode
// ═══════════════════════════════════════════════════════════════════════

describe("classificationToMode", () => {
  it("maps speech → speech", () => {
    expect(classificationToMode("speech")).toBe("speech");
  });

  it("maps music → music", () => {
    expect(classificationToMode("music")).toBe("music");
  });

  it("maps noise → text (P11 fallback)", () => {
    expect(classificationToMode("noise")).toBe("text");
  });

  it("maps text → text", () => {
    expect(classificationToMode("text")).toBe("text");
  });

  it("maps file → file", () => {
    expect(classificationToMode("file")).toBe("file");
  });

  it("maps all ContentClassification values", () => {
    const classifications: ContentClassification[] = [
      "speech",
      "music",
      "noise",
      "text",
      "file",
    ];
    const modes: InputMode[] = ["speech", "music", "text", "text", "file"];

    classifications.forEach((c, i) => {
      expect(classificationToMode(c)).toBe(modes[i]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RuleBasedClassifier
// ═══════════════════════════════════════════════════════════════════════

describe("RuleBasedClassifier", () => {
  let classifier: RuleBasedClassifier;

  beforeEach(() => {
    classifier = new RuleBasedClassifier();
  });

  it("has name 'rule-based' (P15)", () => {
    expect(classifier.name).toBe("rule-based");
  });

  it("implements InputClassifier interface (P7)", () => {
    const iface: InputClassifier = classifier;
    expect(typeof iface.classify).toBe("function");
    expect(typeof iface.name).toBe("string");
  });

  // ── Keystroke ─────────────────────────────────────────────────────

  it("classifies keystroke as text with confidence 1.0", async () => {
    const result = await classifier.classify(makeEvent("keystroke", { text: "hello" }));
    expect(result.classification).toBe("text");
    expect(result.confidence).toBe(1.0);
    expect(result.mode).toBe("text");
  });

  // ── Paste ─────────────────────────────────────────────────────────

  it("classifies paste as text with confidence 1.0", async () => {
    const result = await classifier.classify(
      makeEvent("paste", { text: "pasted content" })
    );
    expect(result.classification).toBe("text");
    expect(result.confidence).toBe(1.0);
    expect(result.mode).toBe("text");
  });

  // ── File ──────────────────────────────────────────────────────────

  it("classifies file as file with confidence 1.0", async () => {
    const result = await classifier.classify(makeEvent("file"));
    expect(result.classification).toBe("file");
    expect(result.confidence).toBe(1.0);
    expect(result.mode).toBe("file");
  });

  // ── Mic ───────────────────────────────────────────────────────────

  it("classifies mic as speech with confidence 0.5 (P7 — rule-based limitation)", async () => {
    const result = await classifier.classify(makeEvent("mic"));
    expect(result.classification).toBe("speech");
    expect(result.confidence).toBe(0.5);
    expect(result.mode).toBe("speech");
  });

  // ── Common Result Fields ──────────────────────────────────────────

  it("always sets classifiedBy to 'rule-based' (P15)", async () => {
    const events: InputEvent["type"][] = ["keystroke", "paste", "file", "mic"];
    for (const type of events) {
      const result = await classifier.classify(makeEvent(type));
      expect(result.classifiedBy).toBe("rule-based");
    }
  });

  it("always sets cost to 0 (P12 — no AI calls)", async () => {
    const events: InputEvent["type"][] = ["keystroke", "paste", "file", "mic"];
    for (const type of events) {
      const result = await classifier.classify(makeEvent(type));
      expect(result.cost).toBe(0);
    }
  });

  it("records latencyMs (P3)", async () => {
    const result = await classifier.classify(makeEvent("keystroke"));
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not include audio features for non-audio events", async () => {
    const result = await classifier.classify(makeEvent("keystroke"));
    expect(result.features).toBeUndefined();
  });
});
