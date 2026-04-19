/**
 * components/AdaptiveInput/AdaptiveInput.tsx — Adaptive input component
 *
 * Generic input component driven entirely by the agent output contract.
 * The UI renders whatever the conductor returns — no hardcoded behavior.
 *
 * Consumers (Playform) provide their own IntentResolver and event handlers.
 * This component handles ONLY the visual rendering and user interaction,
 * never business logic.
 *
 * UX Design:
 *   - Single unified input area — user just starts doing
 *   - Mode pills are indicators AND clickable overrides (P10)
 *   - Intent bar shows what the agent classified
 *   - Action buttons rendered from ActionItem[] — fully dynamic
 *   - Textarea with inline mic + upload icons
 *   - Character counter with configurable max
 *   - "Listening..." badge + waveform when audio active
 *   - Gray for info, red for errors only (UX rule)
 *
 * Accessibility:
 *   - aria-live="polite" on intent bar (screen reader announces changes)
 *   - aria-pressed on mode pills (toggleable)
 *   - role="status" on character counter
 *   - Labels on all interactive elements
 *
 * GenAI Principles:
 *   P1  — Renders structured agent output, not ad-hoc UI state
 *   P6  — Consumes ConductorOutput, ActionItem[] typed schemas
 *   P10 — Mode pills allow human override of agent classification
 *   P11 — Graceful: shows "Processing..." if no intent available
 *
 * @module components/AdaptiveInput
 */

"use client";

import React, { useCallback, useRef } from "react";
import type { InputMode, ConductorOutput, ActionItem } from "@/platform/input/types";

// ── Props ─────────────────────────────────────────────────────────────

export interface AdaptiveInputProps {
  /** Current conductor output — drives all visual state */
  readonly output: ConductorOutput;
  /** Current text in the input area */
  readonly text: string;
  /** Maximum character count */
  readonly maxChars?: number;
  /** Whether audio recording is active */
  readonly isRecording?: boolean;
  /** Whether the component is in a loading/processing state */
  readonly isProcessing?: boolean;
  /** Placeholder text for the textarea */
  readonly placeholder?: string;
  /** Whether the textarea is disabled */
  readonly disabled?: boolean;

  // ── Event Handlers ──
  /** Called when text changes */
  readonly onTextChange: (text: string) => void;
  /** Called when a mode pill is clicked (P10 — human override) */
  readonly onModeSelect: (mode: InputMode) => void;
  /** Called when an action button is clicked */
  readonly onAction: (actionId: string) => void;
  /** Called when mic button is clicked */
  readonly onMicToggle: () => void;
  /** Called when upload button is clicked */
  readonly onUpload: () => void;

  // ── Optional Slots ──
  /** Optional: content rendered below the input (e.g., From/To language bar) */
  readonly languageBar?: React.ReactNode;
  /** Optional: content rendered below the intent bar (e.g., waveform) */
  readonly audioFeedback?: React.ReactNode;
}

// ── Mode Configuration ────────────────────────────────────────────────

const MODE_CONFIG: Record<InputMode, { label: string; ariaLabel: string }> = {
  text: { label: "Text", ariaLabel: "Text input mode" },
  speech: { label: "Speech", ariaLabel: "Speech input mode" },
  music: { label: "Music", ariaLabel: "Music identification mode" },
  file: { label: "File", ariaLabel: "File upload mode" },
};

const MODES: InputMode[] = ["text", "speech", "music", "file"];

// ── Component ─────────────────────────────────────────────────────────

export default function AdaptiveInput({
  output,
  text,
  maxChars = 2500,
  isRecording = false,
  isProcessing = false,
  placeholder = "Type, speak, or drop a file...",
  disabled = false,
  onTextChange,
  onModeSelect,
  onAction,
  onMicToggle,
  onUpload,
  languageBar,
  audioFeedback,
}: AdaptiveInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const charCount = text.length;
  const isOverLimit = charCount > maxChars;

  const handleUploadClick = useCallback(() => {
    onUpload();
    fileInputRef.current?.click();
  }, [onUpload]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onTextChange(e.target.value);
    },
    [onTextChange]
  );

  // Determine intent display text
  const intentDisplay = output.intent?.displayLabel ?? null;
  const intentConfidence = output.intent?.confidence ?? 0;
  const actions = output.intent?.actions ?? [];

  return (
    <div className="w-full max-w-2xl mx-auto" data-testid="adaptive-input">
      {/* Mode Pills */}
      <div className="flex gap-2 mb-3" role="group" aria-label="Input mode selection">
        {MODES.map((mode) => {
          const isActive = output.mode === mode;
          const config = MODE_CONFIG[mode];
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onModeSelect(mode)}
              aria-pressed={isActive}
              aria-label={config.ariaLabel}
              disabled={disabled}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
              data-testid={`mode-pill-${mode}`}
            >
              {config.label}
            </button>
          );
        })}
      </div>

      {/* Intent Bar */}
      {intentDisplay && (
        <div
          className="mb-2 px-3 py-1.5 rounded-md bg-gray-50 text-sm text-gray-600 flex items-center justify-between"
          aria-live="polite"
          data-testid="intent-bar"
        >
          <span>{intentDisplay}</span>
          {intentConfidence > 0 && (
            <span className="text-xs text-gray-600" data-testid="intent-confidence">
              {Math.round(intentConfidence * 100)}%
            </span>
          )}
        </div>
      )}

      {/* Audio Feedback Slot */}
      {audioFeedback}

      {/* Listening Badge */}
      {isRecording && (
        <div
          className="mb-2 flex items-center gap-2 text-sm text-gray-500"
          aria-live="polite"
          data-testid="listening-badge"
        >
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span>Listening...</span>
        </div>
      )}

      {/* Input Area */}
      <div className="relative border rounded-lg border-gray-200 focus-within:border-blue-400 transition-colors">
        <textarea
          value={text}
          onChange={handleTextChange}
          placeholder={placeholder}
          disabled={disabled || isProcessing}
          maxLength={maxChars + 100} // Allow slight overshoot for UX, counter shows warning
          rows={4}
          className="w-full px-4 py-3 pr-20 resize-none rounded-lg bg-transparent text-gray-900 placeholder-gray-400 focus:outline-none disabled:opacity-50"
          aria-label="Input text"
          data-testid="input-textarea"
        />

        {/* Inline Toolbar (mic + upload) */}
        <div className="absolute bottom-2 right-2 flex gap-1">
          <button
            type="button"
            onClick={onMicToggle}
            disabled={disabled}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
            aria-pressed={isRecording}
            className={`p-2 rounded-md transition-colors ${
              isRecording
                ? "bg-red-100 text-red-600"
                : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            data-testid="mic-button"
          >
            <MicIcon />
          </button>
          <button
            type="button"
            onClick={handleUploadClick}
            disabled={disabled}
            aria-label="Upload file"
            className={`p-2 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors ${
              disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
            }`}
            data-testid="upload-button"
          >
            <UploadIcon />
          </button>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            data-testid="file-input"
          />
        </div>
      </div>

      {/* Character Counter */}
      <div
        className="mt-1 text-right text-xs"
        role="status"
        aria-label={`${charCount} of ${maxChars} characters used`}
        data-testid="char-counter"
      >
        <span className={isOverLimit ? "text-red-500" : "text-gray-400"}>
          {charCount}/{maxChars}
        </span>
      </div>

      {/* Language Bar Slot */}
      {languageBar}

      {/* Action Buttons */}
      {actions.length > 0 && (
        <div
          className="flex gap-2 mt-3"
          role="group"
          aria-label="Available actions"
          data-testid="action-buttons"
        >
          {actions.map((action: ActionItem) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onAction(action.id)}
              disabled={disabled || isProcessing || action.disabled}
              aria-label={action.label}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                action.primary
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              } ${
                disabled || isProcessing || action.disabled
                  ? "opacity-50 cursor-not-allowed"
                  : "cursor-pointer"
              }`}
              data-testid={`action-${action.id}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Processing Indicator */}
      {isProcessing && (
        <div
          className="mt-2 text-sm text-gray-500"
          aria-live="polite"
          aria-busy="true"
          data-testid="processing-indicator"
        >
          Processing...
        </div>
      )}
    </div>
  );
}

// ── Icons (inline SVG — no external dependencies) ─────────────────────

function MicIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M8 1a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0V3a2 2 0 0 0-2-2Z" fill="currentColor" />
      <path
        d="M4 6.5a.5.5 0 0 0-1 0 5 5 0 0 0 4.5 4.975V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-2.025A5 5 0 0 0 13 6.5a.5.5 0 0 0-1 0 4 4 0 1 1-8 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8 1.5a.5.5 0 0 1 .5.5v6.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 8.793V2a.5.5 0 0 1 .5-.5Z"
        fill="currentColor"
      />
      <path
        d="M2 12.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
