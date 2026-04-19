/**
 * Sprint 1a — Input conductor tests
 *
 * Tests for InputConductor interface and DefaultInputConductor.
 * This is the core orchestration test — verifies the full
 * event → classify → resolve → emit pipeline.
 *
 * 18-principle mapping: P1 P2 P3 P7 P10 P11 P15 P17 P18
 */

import {
  DefaultInputConductor,
  RuleBasedClassifier,
  DefaultIntentResolver,
  type InputConductor,
  type InputClassifier,
  type IntentResolver,
  type IntentContext,
  type InputEvent,
  type ClassificationResult,
  type IntentResult,
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

function makeContext(overrides?: Partial<IntentContext>): IntentContext {
  return {
    currentMode: "text",
    hasText: false,
    isRecording: false,
    ...overrides,
  };
}

// ── Mock implementations for failure testing ──────────────────────────

class FailingClassifier implements InputClassifier {
  readonly name = "failing";
  async classify(_event: InputEvent): Promise<ClassificationResult> {
    throw new Error("classifier-down");
  }
}

class FailingResolver implements IntentResolver {
  readonly name = "failing";
  async resolve(
    _classification: ClassificationResult,
    _context: IntentContext
  ): Promise<IntentResult> {
    throw new Error("resolver-down");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DefaultInputConductor — Construction
// ═══════════════════════════════════════════════════════════════════════

describe("DefaultInputConductor — construction", () => {
  it("uses default classifier and resolver if none provided (P7)", () => {
    const conductor = new DefaultInputConductor();
    expect(conductor.identity.actorType).toBe("agent");
    expect(conductor.identity.agentRole).toBe("conductor");
  });

  it("accepts custom classifier and resolver (P7)", () => {
    const classifier = new RuleBasedClassifier();
    const resolver = new DefaultIntentResolver();
    const conductor = new DefaultInputConductor(classifier, resolver);
    expect(conductor.identity.agentRole).toBe("conductor");
  });

  it("accepts custom actorId (P15)", () => {
    const conductor = new DefaultInputConductor(undefined, undefined, "my-conductor");
    expect(conductor.identity.actorId).toBe("my-conductor");
  });

  it("has default actorId if none provided", () => {
    const conductor = new DefaultInputConductor();
    expect(conductor.identity.actorId).toBe("conductor-default");
  });

  it("implements InputConductor interface", () => {
    const conductor: InputConductor = new DefaultInputConductor();
    expect(typeof conductor.processEvent).toBe("function");
    expect(typeof conductor.forceMode).toBe("function");
    expect(typeof conductor.getCurrentOutput).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DefaultInputConductor — processEvent
// ═══════════════════════════════════════════════════════════════════════

describe("DefaultInputConductor — processEvent (P2)", () => {
  let conductor: DefaultInputConductor;

  beforeEach(() => {
    conductor = new DefaultInputConductor();
  });

  it("processes keystroke → text mode + process_text intent", async () => {
    const output = await conductor.processEvent(
      makeEvent("keystroke", { text: "hello" }),
      makeContext()
    );

    expect(output.mode).toBe("text");
    expect(output.modeForced).toBe(false);
    expect(output.classifying).toBe(false);
    expect(output.classification).not.toBeNull();
    expect(output.classification!.classification).toBe("text");
    expect(output.intent).not.toBeNull();
    expect(output.intent!.intent).toBe("process_text");
  });

  it("processes paste → text mode", async () => {
    const output = await conductor.processEvent(
      makeEvent("paste", { text: "pasted" }),
      makeContext()
    );
    expect(output.mode).toBe("text");
    expect(output.classification!.classification).toBe("text");
  });

  it("processes file → file mode + extract intent", async () => {
    const output = await conductor.processEvent(makeEvent("file"), makeContext());
    expect(output.mode).toBe("file");
    expect(output.intent!.intent).toBe("extract");
  });

  it("processes mic → speech mode + transcribe intent", async () => {
    const output = await conductor.processEvent(makeEvent("mic"), makeContext());
    expect(output.mode).toBe("speech");
    expect(output.intent!.intent).toBe("transcribe");
  });

  it("returns actions in the intent result (P6)", async () => {
    const output = await conductor.processEvent(makeEvent("keystroke"), makeContext());
    expect(output.intent!.actions.length).toBeGreaterThan(0);
    const primary = output.intent!.actions.filter((a) => a.primary);
    expect(primary).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DefaultInputConductor — forceMode (P10)
// ═══════════════════════════════════════════════════════════════════════

describe("DefaultInputConductor — forceMode (P10)", () => {
  let conductor: DefaultInputConductor;

  beforeEach(() => {
    conductor = new DefaultInputConductor();
  });

  it("forces text mode", async () => {
    const output = await conductor.forceMode("text", makeContext());
    expect(output.mode).toBe("text");
    expect(output.modeForced).toBe(true);
    expect(output.classification!.classifiedBy).toBe("user-forced");
    expect(output.classification!.confidence).toBe(1.0);
  });

  it("forces speech mode", async () => {
    const output = await conductor.forceMode("speech", makeContext());
    expect(output.mode).toBe("speech");
    expect(output.modeForced).toBe(true);
    expect(output.intent!.intent).toBe("transcribe");
  });

  it("forces music mode", async () => {
    const output = await conductor.forceMode("music", makeContext());
    expect(output.mode).toBe("music");
    expect(output.modeForced).toBe(true);
    expect(output.intent!.intent).toBe("identify");
  });

  it("forces file mode", async () => {
    const output = await conductor.forceMode("file", makeContext());
    expect(output.mode).toBe("file");
    expect(output.modeForced).toBe(true);
    expect(output.intent!.intent).toBe("extract");
  });

  it("overrides previous classification", async () => {
    // First: classify as text via keystroke
    await conductor.processEvent(makeEvent("keystroke"), makeContext());
    expect(conductor.getCurrentOutput().mode).toBe("text");

    // Force to music mode
    const output = await conductor.forceMode("music", makeContext());
    expect(output.mode).toBe("music");
    expect(output.modeForced).toBe(true);
  });

  it("processEvent after forceMode resets modeForced", async () => {
    await conductor.forceMode("music", makeContext());
    expect(conductor.getCurrentOutput().modeForced).toBe(true);

    const output = await conductor.processEvent(makeEvent("keystroke"), makeContext());
    expect(output.modeForced).toBe(false);
    expect(output.mode).toBe("text");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DefaultInputConductor — getCurrentOutput
// ═══════════════════════════════════════════════════════════════════════

describe("DefaultInputConductor — getCurrentOutput", () => {
  it("returns initial state before any events", () => {
    const conductor = new DefaultInputConductor();
    const output = conductor.getCurrentOutput();

    expect(output.mode).toBe("text");
    expect(output.classification).toBeNull();
    expect(output.intent).toBeNull();
    expect(output.modeForced).toBe(false);
    expect(output.classifying).toBe(false);
  });

  it("returns latest state after processing", async () => {
    const conductor = new DefaultInputConductor();

    await conductor.processEvent(makeEvent("mic"), makeContext());
    const output = conductor.getCurrentOutput();

    expect(output.mode).toBe("speech");
    expect(output.classification).not.toBeNull();
    expect(output.intent).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DefaultInputConductor — Resilient Degradation (P11)
// ═══════════════════════════════════════════════════════════════════════

describe("DefaultInputConductor — resilient degradation (P11)", () => {
  it("falls back to text mode when classifier throws", async () => {
    const conductor = new DefaultInputConductor(new FailingClassifier());

    const output = await conductor.processEvent(makeEvent("mic"), makeContext());

    // Should NOT throw — falls back gracefully
    expect(output.mode).toBe("text");
    expect(output.classification!.classification).toBe("text");
    expect(output.classification!.confidence).toBe(0);
    expect(output.classification!.classifiedBy).toBe("fallback");
  });

  it("returns empty actions when resolver throws", async () => {
    const conductor = new DefaultInputConductor(
      new RuleBasedClassifier(),
      new FailingResolver()
    );

    const output = await conductor.processEvent(makeEvent("keystroke"), makeContext());

    // Classification succeeds, intent resolution fails gracefully
    expect(output.classification!.classification).toBe("text");
    expect(output.intent!.intent).toBe("unknown");
    expect(output.intent!.actions).toHaveLength(0);
    expect(output.intent!.resolvedBy).toBe("fallback");
  });

  it("handles both classifier and resolver failing", async () => {
    const conductor = new DefaultInputConductor(
      new FailingClassifier(),
      new FailingResolver()
    );

    const output = await conductor.processEvent(makeEvent("mic"), makeContext());

    expect(output.mode).toBe("text");
    expect(output.classification!.classifiedBy).toBe("fallback");
    expect(output.intent!.resolvedBy).toBe("fallback");
  });

  it("handles resolver failure in forceMode", async () => {
    const conductor = new DefaultInputConductor(undefined, new FailingResolver());

    const output = await conductor.forceMode("music", makeContext());

    expect(output.mode).toBe("music");
    expect(output.modeForced).toBe(true);
    expect(output.intent!.intent).toBe("unknown");
    expect(output.intent!.resolvedBy).toBe("fallback");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Custom Classifier and Resolver (P7 — swappable)
// ═══════════════════════════════════════════════════════════════════════

describe("DefaultInputConductor — custom implementations (P7)", () => {
  it("uses injected classifier", async () => {
    const customClassifier: InputClassifier = {
      name: "custom-audio",
      async classify(_event: InputEvent): Promise<ClassificationResult> {
        return {
          classification: "music",
          confidence: 0.95,
          mode: "music",
          classifiedBy: "custom-audio",
          latencyMs: 50,
          cost: 0.001,
        };
      },
    };

    const conductor = new DefaultInputConductor(customClassifier);
    const output = await conductor.processEvent(makeEvent("mic"), makeContext());

    expect(output.classification!.classifiedBy).toBe("custom-audio");
    expect(output.classification!.confidence).toBe(0.95);
    expect(output.mode).toBe("music");
  });

  it("uses injected resolver", async () => {
    const customResolver: IntentResolver = {
      name: "playform",
      async resolve(
        _classification: ClassificationResult,
        _context: IntentContext
      ): Promise<IntentResult> {
        return {
          intent: "translate",
          displayLabel: "Translate text",
          confidence: 1.0,
          actions: [
            { id: "translate", label: "Translate", primary: true },
            { id: "speak", label: "Speak", primary: false },
            { id: "clear", label: "Clear", primary: false },
          ],
          resolvedBy: "playform",
          latencyMs: 1,
          cost: 0,
        };
      },
    };

    const conductor = new DefaultInputConductor(undefined, customResolver);
    const output = await conductor.processEvent(makeEvent("keystroke"), makeContext());

    expect(output.intent!.intent).toBe("translate");
    expect(output.intent!.resolvedBy).toBe("playform");
    expect(output.intent!.actions).toHaveLength(3);
  });
});
