/**
 * @jest-environment jsdom
 */
/**
 * Sprint 1a — AdaptiveInput component tests
 *
 * Tests the generic adaptive input component driven by ConductorOutput.
 * Verifies rendering, mode pills, intent bar, action buttons, accessibility,
 * character counter, and all interactive behaviors.
 *
 * 18-principle mapping: P1 P6 P10 P11 — all via UI contract
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import AdaptiveInput, {
  type AdaptiveInputProps,
} from "@/components/AdaptiveInput/AdaptiveInput";
import type { ConductorOutput, ActionItem } from "@/platform/input";

// ── Helpers ───────────────────────────────────────────────────────────

function makeOutput(overrides?: Partial<ConductorOutput>): ConductorOutput {
  return {
    mode: "text",
    classification: null,
    intent: null,
    modeForced: false,
    classifying: false,
    trajectory: {
      trajectoryId: "traj-test",
      agentId: "conductor-default",
      steps: [],
      status: "completed" as const,
      totalCost: 0,
      createdAt: "2026-04-22T00:00:00Z",
      updatedAt: "2026-04-22T00:00:00Z",
    },
    ...overrides,
  };
}

function makeIntent(overrides?: Partial<ConductorOutput["intent"]>) {
  return {
    intent: "process_text",
    displayLabel: "Process text",
    confidence: 1.0,
    actions: [
      { id: "process", label: "Process", primary: true },
      { id: "clear", label: "Clear", primary: false },
    ] as ActionItem[],
    resolvedBy: "default",
    latencyMs: 0,
    cost: 0,
    ...overrides,
  };
}

const defaultProps: AdaptiveInputProps = {
  output: makeOutput(),
  text: "",
  onTextChange: jest.fn(),
  onModeSelect: jest.fn(),
  onAction: jest.fn(),
  onMicToggle: jest.fn(),
  onUpload: jest.fn(),
};

function renderInput(overrides?: Partial<AdaptiveInputProps>) {
  return render(<AdaptiveInput {...defaultProps} {...overrides} />);
}

// ═══════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — rendering", () => {
  it("renders the component", () => {
    renderInput();
    expect(screen.getByTestId("adaptive-input")).toBeDefined();
  });

  it("renders textarea with placeholder", () => {
    renderInput({ placeholder: "Type something..." });
    const textarea = screen.getByTestId("input-textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Type something...");
  });

  it("renders default placeholder", () => {
    renderInput();
    const textarea = screen.getByTestId("input-textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Type, speak, or drop a file...");
  });

  it("renders mic and upload buttons", () => {
    renderInput();
    expect(screen.getByTestId("mic-button")).toBeDefined();
    expect(screen.getByTestId("upload-button")).toBeDefined();
  });

  it("renders character counter", () => {
    renderInput({ text: "hello" });
    expect(screen.getByTestId("char-counter")).toBeDefined();
    expect(screen.getByTestId("char-counter").textContent).toContain("5/2500");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MODE PILLS (P10)
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — mode pills (P10)", () => {
  it("renders all four mode pills", () => {
    renderInput();
    expect(screen.getByTestId("mode-pill-text")).toBeDefined();
    expect(screen.getByTestId("mode-pill-speech")).toBeDefined();
    expect(screen.getByTestId("mode-pill-music")).toBeDefined();
    expect(screen.getByTestId("mode-pill-file")).toBeDefined();
  });

  it("highlights active mode pill", () => {
    renderInput({ output: makeOutput({ mode: "music" }) });
    const musicPill = screen.getByTestId("mode-pill-music");
    expect(musicPill.getAttribute("aria-pressed")).toBe("true");

    const textPill = screen.getByTestId("mode-pill-text");
    expect(textPill.getAttribute("aria-pressed")).toBe("false");
  });

  it("calls onModeSelect when pill clicked", () => {
    const onModeSelect = jest.fn();
    renderInput({ onModeSelect });

    fireEvent.click(screen.getByTestId("mode-pill-music"));
    expect(onModeSelect).toHaveBeenCalledWith("music");
  });

  it("disables pills when disabled prop is true", () => {
    renderInput({ disabled: true });
    const pill = screen.getByTestId("mode-pill-text") as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// INTENT BAR
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — intent bar", () => {
  it("shows intent bar when intent is available", () => {
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
    });
    expect(screen.getByTestId("intent-bar")).toBeDefined();
    expect(screen.getByTestId("intent-bar").textContent).toContain("Process text");
  });

  it("does not show intent bar when no intent", () => {
    renderInput({ output: makeOutput({ intent: null }) });
    expect(screen.queryByTestId("intent-bar")).toBeNull();
  });

  it("shows confidence percentage", () => {
    renderInput({
      output: makeOutput({
        intent: makeIntent({ confidence: 0.87 }),
      }),
    });
    expect(screen.getByTestId("intent-confidence").textContent).toBe("87%");
  });

  it("hides confidence when 0", () => {
    renderInput({
      output: makeOutput({
        intent: makeIntent({ confidence: 0 }),
      }),
    });
    expect(screen.queryByTestId("intent-confidence")).toBeNull();
  });

  it("has aria-live=polite for screen readers", () => {
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
    });
    expect(screen.getByTestId("intent-bar").getAttribute("aria-live")).toBe("polite");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ACTION BUTTONS (P6)
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — action buttons (P6)", () => {
  it("renders action buttons from intent", () => {
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
    });
    expect(screen.getByTestId("action-buttons")).toBeDefined();
    expect(screen.getByTestId("action-process")).toBeDefined();
    expect(screen.getByTestId("action-clear")).toBeDefined();
  });

  it("does not render action buttons when no intent", () => {
    renderInput({ output: makeOutput({ intent: null }) });
    expect(screen.queryByTestId("action-buttons")).toBeNull();
  });

  it("calls onAction with action id when clicked", () => {
    const onAction = jest.fn();
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
      onAction,
    });

    fireEvent.click(screen.getByTestId("action-process"));
    expect(onAction).toHaveBeenCalledWith("process");

    fireEvent.click(screen.getByTestId("action-clear"));
    expect(onAction).toHaveBeenCalledWith("clear");
  });

  it("renders custom actions from intent resolver", () => {
    const customActions: ActionItem[] = [
      { id: "spotify", label: "Spotify", primary: true },
      { id: "apple-music", label: "Apple Music", primary: false },
      { id: "translate-lyrics", label: "Translate lyrics", primary: false },
    ];
    renderInput({
      output: makeOutput({
        intent: makeIntent({ actions: customActions }),
      }),
    });
    expect(screen.getByTestId("action-spotify")).toBeDefined();
    expect(screen.getByTestId("action-apple-music")).toBeDefined();
    expect(screen.getByTestId("action-translate-lyrics")).toBeDefined();
  });

  it("disables actions when isProcessing", () => {
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
      isProcessing: true,
    });
    const btn = screen.getByTestId("action-process") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("disables individual actions when action.disabled is true", () => {
    const actions: ActionItem[] = [
      { id: "go", label: "Go", primary: true, disabled: true },
      { id: "clear", label: "Clear", primary: false },
    ];
    renderInput({
      output: makeOutput({ intent: makeIntent({ actions }) }),
    });
    const goBtn = screen.getByTestId("action-go") as HTMLButtonElement;
    expect(goBtn.disabled).toBe(true);
    const clearBtn = screen.getByTestId("action-clear") as HTMLButtonElement;
    expect(clearBtn.disabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEXT INPUT
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — text input", () => {
  it("displays current text value", () => {
    renderInput({ text: "hello world" });
    const textarea = screen.getByTestId("input-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello world");
  });

  it("calls onTextChange when text changes", () => {
    const onTextChange = jest.fn();
    renderInput({ onTextChange });

    const textarea = screen.getByTestId("input-textarea");
    fireEvent.change(textarea, { target: { value: "new text" } });
    expect(onTextChange).toHaveBeenCalledWith("new text");
  });

  it("disables textarea when disabled", () => {
    renderInput({ disabled: true });
    const textarea = screen.getByTestId("input-textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it("disables textarea when processing", () => {
    renderInput({ isProcessing: true });
    const textarea = screen.getByTestId("input-textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CHARACTER COUNTER
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — character counter", () => {
  it("shows current count / max", () => {
    renderInput({ text: "abc", maxChars: 100 });
    expect(screen.getByTestId("char-counter").textContent).toContain("3/100");
  });

  it("defaults max to 2500", () => {
    renderInput({ text: "" });
    expect(screen.getByTestId("char-counter").textContent).toContain("0/2500");
  });

  it("has role=status for accessibility", () => {
    renderInput();
    expect(screen.getByTestId("char-counter").getAttribute("role")).toBe("status");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MIC + UPLOAD BUTTONS
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — mic and upload", () => {
  it("calls onMicToggle when mic button clicked", () => {
    const onMicToggle = jest.fn();
    renderInput({ onMicToggle });

    fireEvent.click(screen.getByTestId("mic-button"));
    expect(onMicToggle).toHaveBeenCalled();
  });

  it("calls onUpload when upload button clicked", () => {
    const onUpload = jest.fn();
    renderInput({ onUpload });

    fireEvent.click(screen.getByTestId("upload-button"));
    expect(onUpload).toHaveBeenCalled();
  });

  it("shows recording state on mic button", () => {
    renderInput({ isRecording: true });
    const mic = screen.getByTestId("mic-button");
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.getAttribute("aria-label")).toBe("Stop recording");
  });

  it("shows default state on mic button when not recording", () => {
    renderInput({ isRecording: false });
    const mic = screen.getByTestId("mic-button");
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(mic.getAttribute("aria-label")).toBe("Start recording");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LISTENING BADGE
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — listening badge", () => {
  it("shows when recording", () => {
    renderInput({ isRecording: true });
    expect(screen.getByTestId("listening-badge")).toBeDefined();
    expect(screen.getByTestId("listening-badge").textContent).toContain("Listening...");
  });

  it("hidden when not recording", () => {
    renderInput({ isRecording: false });
    expect(screen.queryByTestId("listening-badge")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PROCESSING STATE
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — processing state", () => {
  it("shows processing indicator when isProcessing", () => {
    renderInput({ isProcessing: true });
    expect(screen.getByTestId("processing-indicator")).toBeDefined();
    expect(screen.getByTestId("processing-indicator").textContent).toContain(
      "Processing..."
    );
  });

  it("has aria-busy on processing indicator", () => {
    renderInput({ isProcessing: true });
    expect(screen.getByTestId("processing-indicator").getAttribute("aria-busy")).toBe(
      "true"
    );
  });

  it("hidden when not processing", () => {
    renderInput({ isProcessing: false });
    expect(screen.queryByTestId("processing-indicator")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OPTIONAL SLOTS
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — slots", () => {
  it("renders language bar slot", () => {
    renderInput({
      languageBar: <div data-testid="lang-bar">EN → ES</div>,
    });
    expect(screen.getByTestId("lang-bar")).toBeDefined();
  });

  it("renders audio feedback slot", () => {
    renderInput({
      audioFeedback: <div data-testid="waveform">≋≋≋</div>,
    });
    expect(screen.getByTestId("waveform")).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ACCESSIBILITY
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — accessibility", () => {
  it("mode pills have aria-label", () => {
    renderInput();
    expect(screen.getByTestId("mode-pill-text").getAttribute("aria-label")).toBe(
      "Text input mode"
    );
    expect(screen.getByTestId("mode-pill-speech").getAttribute("aria-label")).toBe(
      "Speech input mode"
    );
  });

  it("mode pills group has role=group", () => {
    renderInput();
    const group = screen.getByRole("group", { name: "Input mode selection" });
    expect(group).toBeDefined();
  });

  it("textarea has aria-label", () => {
    renderInput();
    expect(screen.getByTestId("input-textarea").getAttribute("aria-label")).toBe(
      "Input text"
    );
  });

  it("action buttons group has role=group", () => {
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
    });
    const group = screen.getByRole("group", { name: "Available actions" });
    expect(group).toBeDefined();
  });

  it("action buttons have aria-label", () => {
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
    });
    expect(screen.getByTestId("action-process").getAttribute("aria-label")).toBe(
      "Process"
    );
  });

  it("upload button has aria-label", () => {
    renderInput();
    expect(screen.getByTestId("upload-button").getAttribute("aria-label")).toBe(
      "Upload file"
    );
  });

  it("hidden file input has aria-hidden", () => {
    renderInput();
    expect(screen.getByTestId("file-input").getAttribute("aria-hidden")).toBe("true");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE CASES AND BRANCH COVERAGE
// ═══════════════════════════════════════════════════════════════════════

describe("AdaptiveInput — edge cases", () => {
  it("shows red text when character count exceeds max", () => {
    const longText = "a".repeat(2501);
    renderInput({ text: longText, maxChars: 2500 });
    const counter = screen.getByTestId("char-counter");
    expect(counter.textContent).toContain("2501/2500");
    // The span should have the red class
    const span = counter.querySelector("span");
    expect(span?.className).toContain("text-red-500");
  });

  it("shows gray text when character count is within limit", () => {
    renderInput({ text: "hello", maxChars: 2500 });
    const counter = screen.getByTestId("char-counter");
    const span = counter.querySelector("span");
    expect(span?.className).toContain("text-gray-400");
  });

  it("disables mic button when disabled", () => {
    renderInput({ disabled: true });
    const mic = screen.getByTestId("mic-button") as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
  });

  it("disables upload button when disabled", () => {
    renderInput({ disabled: true });
    const upload = screen.getByTestId("upload-button") as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
  });

  it("does not render language bar when not provided", () => {
    renderInput();
    expect(screen.queryByTestId("lang-bar")).toBeNull();
  });

  it("does not render audio feedback when not provided", () => {
    renderInput();
    expect(screen.queryByTestId("waveform")).toBeNull();
  });

  it("renders with custom maxChars on character counter", () => {
    renderInput({ text: "test", maxChars: 500 });
    expect(screen.getByTestId("char-counter").textContent).toContain("4/500");
  });

  it("renders no action buttons when intent has empty actions array", () => {
    renderInput({
      output: makeOutput({
        intent: makeIntent({ actions: [] }),
      }),
    });
    expect(screen.queryByTestId("action-buttons")).toBeNull();
  });

  it("highlights only the active mode pill", () => {
    renderInput({ output: makeOutput({ mode: "speech" }) });
    expect(screen.getByTestId("mode-pill-speech").getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByTestId("mode-pill-text").getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(screen.getByTestId("mode-pill-music").getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(screen.getByTestId("mode-pill-file").getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("renders all mode combinations correctly", () => {
    const modes: Array<"text" | "speech" | "music" | "file"> = [
      "text",
      "speech",
      "music",
      "file",
    ];
    for (const mode of modes) {
      const { unmount } = renderInput({ output: makeOutput({ mode }) });
      expect(screen.getByTestId(`mode-pill-${mode}`).getAttribute("aria-pressed")).toBe(
        "true"
      );
      unmount();
    }
  });

  it("disables action buttons when globally disabled", () => {
    renderInput({
      output: makeOutput({ intent: makeIntent() }),
      disabled: true,
    });
    const processBtn = screen.getByTestId("action-process") as HTMLButtonElement;
    const clearBtn = screen.getByTestId("action-clear") as HTMLButtonElement;
    expect(processBtn.disabled).toBe(true);
    expect(clearBtn.disabled).toBe(true);
  });
});
